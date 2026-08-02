export const CHAT_AUDIO_PLAYBACK_RATES = [1, 2, 4] as const

export type ChatAudioPlaybackRate = typeof CHAT_AUDIO_PLAYBACK_RATES[number]

export function getNextChatAudioPlaybackRate(rate: number): ChatAudioPlaybackRate {
  const currentIndex = CHAT_AUDIO_PLAYBACK_RATES.indexOf(rate as ChatAudioPlaybackRate)
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % CHAT_AUDIO_PLAYBACK_RATES.length
  return CHAT_AUDIO_PLAYBACK_RATES[nextIndex]
}

export function formatChatAudioPlaybackRate(rate: number) {
  return `${Number.isInteger(rate) ? rate.toFixed(0) : rate}x`
}

export function clampChatAudioProgress(progress: number) {
  if (!Number.isFinite(progress)) return 0
  return Math.min(1, Math.max(0, progress))
}

export function getChatAudioProgressFromClientX(clientX: number, trackLeft: number, trackWidth: number) {
  if (!Number.isFinite(trackWidth) || trackWidth <= 0) return 0
  return clampChatAudioProgress((clientX - trackLeft) / trackWidth)
}

export function getChatAudioSeekSeconds(
  clientX: number,
  trackLeft: number,
  trackWidth: number,
  durationSeconds: number
) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0
  return getChatAudioProgressFromClientX(clientX, trackLeft, trackWidth) * durationSeconds
}
