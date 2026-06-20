import { AlertCircle, CheckCircle2, Loader2, UploadCloud, X } from 'lucide-react'
import styles from './MediaUploadTray.module.css'

export type MediaUploadTaskStatus = 'uploading' | 'processing' | 'complete' | 'error'

export interface MediaUploadTask {
  id: string
  filename: string
  size: number
  progress: number | null
  status: MediaUploadTaskStatus
  message?: string
}

export interface MediaUploadTrayProps {
  tasks: MediaUploadTask[]
  scope?: 'page' | 'modal'
  onCancelTask?: (taskId: string) => void
  onDismissTask?: (taskId: string) => void
  onClearFinished?: () => void
}

function formatUploadSize(size: number) {
  if (!Number.isFinite(size) || size <= 0) return 'Tamaño desconocido'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = size
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const fractionDigits = value >= 10 || unitIndex === 0 ? 0 : 1
  return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`
}

function getTaskStatusLabel(task: MediaUploadTask) {
  if (task.status === 'complete') return 'Listo'
  if (task.status === 'error') return 'Error'
  if (task.status === 'processing') return 'Procesando'
  return task.progress === null ? 'Subiendo' : `${task.progress}%`
}

function getTaskIcon(task: MediaUploadTask) {
  if (task.status === 'complete') return <CheckCircle2 size={16} aria-hidden="true" />
  if (task.status === 'error') return <AlertCircle size={16} aria-hidden="true" />
  return <Loader2 size={16} className={styles.spin} aria-hidden="true" />
}

export function MediaUploadTray({
  tasks,
  scope = 'page',
  onCancelTask,
  onDismissTask,
  onClearFinished
}: MediaUploadTrayProps) {
  if (!tasks.length) return null

  const activeCount = tasks.filter((task) => task.status === 'uploading' || task.status === 'processing').length
  const finishedCount = tasks.length - activeCount
  const title = activeCount
    ? `Subiendo ${activeCount} archivo${activeCount === 1 ? '' : 's'}`
    : 'Subidas completas'

  return (
    <aside
      className={styles.tray}
      data-scope={scope}
      role="status"
      aria-live="polite"
      aria-label="Estado de subidas de Media"
    >
      <header className={styles.header}>
        <span className={styles.headerIcon}>
          <UploadCloud size={17} aria-hidden="true" />
        </span>
        <div className={styles.headerText}>
          <strong>{title}</strong>
          <span>{tasks.length} en esta tanda</span>
        </div>
        {finishedCount > 0 && onClearFinished ? (
          <button type="button" className={styles.clearButton} onClick={onClearFinished} aria-label="Quitar subidas terminadas">
            <X size={15} />
          </button>
        ) : null}
      </header>

      <div className={styles.list}>
        {tasks.map((task) => {
          const progress = task.progress === null ? 100 : task.progress
          const canCancel = task.status === 'uploading' || task.status === 'processing'
          const canDismiss = task.status === 'complete' || task.status === 'error'

          return (
            <div key={task.id} className={styles.row} data-status={task.status}>
              <span className={styles.statusIcon}>{getTaskIcon(task)}</span>
              <span className={styles.fileInfo}>
                <strong title={task.filename}>{task.filename}</strong>
                <small>{task.message || formatUploadSize(task.size)}</small>
                <span className={styles.progressTrack} aria-hidden="true">
                  <span style={{ width: `${progress}%` }} />
                </span>
              </span>
              <span className={styles.percent}>{getTaskStatusLabel(task)}</span>
              {canCancel && onCancelTask ? (
                <button type="button" className={styles.dismissButton} onClick={() => onCancelTask(task.id)} aria-label={`Cancelar subida de ${task.filename}`} title="Cancelar subida">
                  <X size={14} />
                </button>
              ) : null}
              {canDismiss && onDismissTask ? (
                <button type="button" className={styles.dismissButton} onClick={() => onDismissTask(task.id)} aria-label={`Quitar ${task.filename}`}>
                  <X size={14} />
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
