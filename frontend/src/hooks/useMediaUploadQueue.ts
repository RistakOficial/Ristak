import { useCallback, useEffect, useRef, useState } from 'react'
import type { MediaUploadTask, MediaUploadTaskStatus } from '@/components/common/MediaUploadTray'
import { MEDIA_UPLOAD_CANCELLED_MESSAGE } from '@/services/mediaService'

function createUploadTaskId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function useMediaUploadQueue() {
  const [tasks, setTasks] = useState<MediaUploadTask[]>([])
  const controllersRef = useRef(new Map<string, AbortController>())

  useEffect(() => () => {
    controllersRef.current.forEach((controller) => {
      if (!controller.signal.aborted) controller.abort()
    })
    controllersRef.current.clear()
  }, [])

  const addTask = useCallback((file: File) => {
    const id = createUploadTaskId()
    const controller = new AbortController()
    controllersRef.current.set(id, controller)
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
    return { id, signal: controller.signal }
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
    controllersRef.current.delete(taskId)
    updateTask(taskId, {
      status,
      progress: status === 'error' ? null : 100,
      message
    })
  }, [updateTask])

  const dismissTask = useCallback((taskId: string) => {
    controllersRef.current.delete(taskId)
    setTasks((current) => current.filter((task) => task.id !== taskId))
  }, [])

  const cancelTask = useCallback((taskId: string) => {
    const controller = controllersRef.current.get(taskId)
    if (controller && !controller.signal.aborted) {
      controller.abort()
    }
    setTasks((current) => current.map((task) => {
      if (task.id !== taskId || (task.status !== 'uploading' && task.status !== 'processing')) {
        return task
      }
      return {
        ...task,
        progress: null,
        status: 'error',
        message: MEDIA_UPLOAD_CANCELLED_MESSAGE
      }
    }))
  }, [])

  const clearFinished = useCallback(() => {
    setTasks((current) => current.filter((task) => {
      const active = task.status === 'uploading' || task.status === 'processing'
      if (!active) controllersRef.current.delete(task.id)
      return active
    }))
  }, [])

  return {
    tasks,
    addTask,
    updateTask,
    setTaskProgress,
    finishTask,
    dismissTask,
    cancelTask,
    clearFinished
  }
}
