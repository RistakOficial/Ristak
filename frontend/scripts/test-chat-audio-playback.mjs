import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'

const sourceUrl = new URL('../src/utils/chatAudioPlayback.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const desktopChatSource = await readFile(new URL('../src/pages/DesktopChat/DesktopChat.tsx', import.meta.url), 'utf8')
const desktopChatStyles = await readFile(new URL('../src/pages/DesktopChat/DesktopChat.module.css', import.meta.url), 'utf8')
const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2020' })
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`
const {
  CHAT_AUDIO_PLAYBACK_RATES,
  clampChatAudioProgress,
  formatChatAudioPlaybackRate,
  getChatAudioProgressFromClientX,
  getChatAudioSeekSeconds,
  getNextChatAudioPlaybackRate
} = await import(moduleUrl)

assert.deepEqual(CHAT_AUDIO_PLAYBACK_RATES, [1, 2, 4])
assert.equal(getNextChatAudioPlaybackRate(1), 2)
assert.equal(getNextChatAudioPlaybackRate(2), 4)
assert.equal(getNextChatAudioPlaybackRate(4), 1)
assert.equal(getNextChatAudioPlaybackRate(99), 1)
assert.equal(formatChatAudioPlaybackRate(1), '1x')
assert.equal(formatChatAudioPlaybackRate(4), '4x')

assert.equal(clampChatAudioProgress(-1), 0)
assert.equal(clampChatAudioProgress(0.35), 0.35)
assert.equal(clampChatAudioProgress(8), 1)
assert.equal(getChatAudioProgressFromClientX(150, 100, 200), 0.25)
assert.equal(getChatAudioProgressFromClientX(20, 100, 200), 0)
assert.equal(getChatAudioProgressFromClientX(500, 100, 200), 1)
assert.equal(getChatAudioSeekSeconds(250, 100, 300, 120), 60)
assert.equal(getChatAudioSeekSeconds(100, 100, 0, 120), 0)
assert.equal(getChatAudioSeekSeconds(250, 100, 300, Number.NaN), 0)

assert.match(desktopChatSource, /role="slider"/, 'la onda debe exponerse como control de posición')
assert.match(desktopChatSource, /setPointerCapture\(event\.pointerId\)/, 'el arrastre debe conservar el puntero fuera de la onda')
assert.match(desktopChatSource, /onPointerMove=/, 'la posición debe actualizarse durante el arrastre')
assert.match(desktopChatSource, /handleMessageAudioSeekKeyDown/, 'el control debe aceptar búsqueda por teclado')
assert.match(desktopChatSource, /handleCycleMessageAudioRate/, 'el avatar debe alternar la velocidad')
assert.match(desktopChatSource, /audio\.preservesPitch = true/, 'la voz acelerada debe conservar el tono')
assert.match(desktopChatStyles, /\.audioWaveform[\s\S]*?touch-action:\s*none;/, 'el gesto horizontal no debe competir con el navegador')
assert.match(desktopChatStyles, /\.audioWaveBarPlayed\s*{[\s\S]*?background:\s*var\(--accent\);/, 'el progreso debe usar el acento del tema')

console.log('Desktop Chat audio playback contract OK')
