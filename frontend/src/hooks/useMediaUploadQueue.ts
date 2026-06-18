import { useCallback, useState } from 'react'
import type { MediaUploadTask, MediaUploadTaskStatus } from '@/components/common/MediaUploadTray'

function createUploadTaskId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function useMediaUploadQueue() {
  const [tasks, setTasks] = useState<MediaUploadTask[]>([])

  const addTask = useCallback((file: File) => {
    const id = createUploadTaskId()
    setTasks((current) => [
      {
        id,
        filename: file.name,
        size: file.size,
        progress: 0,
        status: 'uploading'
      },
      ...current
    ])
    return id
  }, [])

  const updateTask = useCallback((taskId: string, patch: Partial<MediaUploadTask>) => {
    setTasks((current) => current.map((task) => task.id === taskId ? { ...task, ...patch } : task))
  }, [])

  const setTaskProgress = useCallback((taskId: string, progress: number) => {
    const nextProgress = Math.max(0, Math.min(100, progress))
    updateTask(taskId, {
      progress: nextProgress,
      status: nextProgress >= 100 ? 'processing' : 'uploading'
    })
  }, [updateTask])

  const finishTask = useCallback((taskId: string, status: MediaUploadTaskStatus, message?: string) => {
    updateTask(taskId, {
      status,
      progress: status === 'error' ? null : 100,
      message
    })
  }, [updateTask])

  const dismissTask = useCallback((taskId: string) => {
    setTasks((current) => current.filter((task) => task.id !== taskId))
  }, [])

  const clearFinished = useCallback(() => {
    setTasks((current) => current.filter((task) => task.status === 'uploading' || task.status === 'processing'))
  }, [])

  return {
    tasks,
    addTask,
    updateTask,
    setTaskProgress,
    finishTask,
    dismissTask,
    clearFinished
  }
}
