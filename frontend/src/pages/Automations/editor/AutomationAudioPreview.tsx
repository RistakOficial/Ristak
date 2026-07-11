import React, { useEffect, useState } from 'react'
import { Loader2, Pause, Play } from 'lucide-react'
import { cn } from '@/utils/cn'
import styles from './AutomationEditor.module.css'

interface PlaybackSnapshot {
  currentTime: number
  duration: number
  isPlaying: boolean
  isLoading: boolean
  hasError: boolean
}

interface AudioRecord {
  audio: HTMLAudioElement
  listeners: Set<(snapshot: PlaybackSnapshot) => void>
  hasError: boolean
}

const audioRecords = new Map<string, AudioRecord>()

function snapshotFor(record: AudioRecord): PlaybackSnapshot {
  const { audio } = record
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0
  const currentTime = Number.isFinite(audio.currentTime) ? Math.min(audio.currentTime, duration || audio.currentTime) : 0

  return {
    currentTime,
    duration,
    isPlaying: !audio.paused && !audio.ended,
    isLoading: !audio.paused && audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
    hasError: record.hasError
  }
}

function publish(record: AudioRecord) {
  const snapshot = snapshotFor(record)
  record.listeners.forEach((listener) => listener(snapshot))
}

function getAudioRecord(source: string): AudioRecord {
  const existing = audioRecords.get(source)
  if (existing) return existing

  const audio = new Audio()
  audio.preload = 'metadata'
  audio.src = source

  const record: AudioRecord = {
    audio,
    listeners: new Set(),
    hasError: false
  }

  const refresh = () => publish(record)
  audio.addEventListener('loadedmetadata', refresh)
  audio.addEventListener('durationchange', refresh)
  audio.addEventListener('timeupdate', refresh)
  audio.addEventListener('canplay', refresh)
  audio.addEventListener('waiting', refresh)
  audio.addEventListener('play', refresh)
  audio.addEventListener('pause', refresh)
  audio.addEventListener('ended', () => {
    audio.currentTime = 0
    refresh()
  })
  audio.addEventListener('error', () => {
    record.hasError = true
    refresh()
  })

  audioRecords.set(source, record)
  audio.load()
  return record
}

function subscribeToPlayback(source: string, listener: (snapshot: PlaybackSnapshot) => void) {
  const record = getAudioRecord(source)
  record.listeners.add(listener)
  listener(snapshotFor(record))

  return () => {
    record.listeners.delete(listener)
    if (record.listeners.size > 0) return

    record.audio.pause()
    record.audio.removeAttribute('src')
    record.audio.load()
    audioRecords.delete(source)
  }
}

async function togglePlayback(source: string) {
  const record = getAudioRecord(source)

  if (!record.audio.paused) {
    record.audio.pause()
    return
  }

  for (const [otherSource, otherRecord] of audioRecords) {
    if (otherSource !== source && !otherRecord.audio.paused) otherRecord.audio.pause()
  }

  record.hasError = false
  try {
    await record.audio.play()
  } catch {
    record.hasError = true
    publish(record)
  }
}

function seekPlayback(source: string, seconds: number) {
  const record = getAudioRecord(source)
  if (!Number.isFinite(record.audio.duration) || record.audio.duration <= 0) return

  record.audio.currentTime = Math.min(Math.max(seconds, 0), record.audio.duration)
  publish(record)
}

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  const totalSeconds = Math.floor(value)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

interface AutomationAudioPreviewProps {
  src: string
  compact?: boolean
}

/**
 * Un único elemento de audio por URL. La tarjeta del flujo y el panel de
 * configuración se suscriben al mismo reproductor, así que su estado nunca se
 * separa ni reproduce dos copias del mismo mensaje de voz.
 */
export function AutomationAudioPreview({ src, compact = false }: AutomationAudioPreviewProps) {
  const [playback, setPlayback] = useState<PlaybackSnapshot>({
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    isLoading: false,
    hasError: false
  })

  useEffect(() => subscribeToPlayback(src, setPlayback), [src])

  const progress = playback.duration > 0 ? playback.currentTime / playback.duration : 0
  const playLabel = playback.isPlaying ? 'Pausar audio' : 'Reproducir audio'

  return (
    <div
      className={cn(styles.automationAudioPreview, compact && styles.automationAudioPreviewCompact)}
      aria-label="Vista previa de audio"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={styles.automationAudioToggle}
        aria-label={playLabel}
        title={playLabel}
        onClick={() => void togglePlayback(src)}
      >
        {playback.isLoading ? <Loader2 size={15} className={styles.automationAudioSpinner} /> : playback.isPlaying ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
      </button>
      <span className={styles.automationAudioTime}>{formatTime(playback.currentTime)}</span>
      <input
        type="range"
        className={styles.automationAudioProgress}
        min={0}
        max={playback.duration || 0}
        step={0.1}
        value={Math.min(playback.currentTime, playback.duration || 0)}
        disabled={playback.duration <= 0}
        aria-label="Avance del audio"
        style={{ '--audio-progress': progress } as React.CSSProperties}
        onChange={(event) => seekPlayback(src, Number(event.target.value))}
      />
      <span className={styles.automationAudioTime}>{formatTime(playback.duration)}</span>
      {playback.hasError && <span className={styles.automationAudioError}>No se pudo reproducir</span>}
    </div>
  )
}
