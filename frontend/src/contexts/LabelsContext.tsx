import React, { createContext, useCallback, useContext, useRef, useState, useEffect, ReactNode } from 'react'
import { AUTH_PRINCIPAL_CHANGED_EVENT } from '@/services/authPrincipalCache'
import { crmLabelsService } from '@/services/crmLabelsService'
import { DEFAULT_CRM_LABELS, normalizeCrmLabels, type CrmLabels } from '@/utils/crmLabels'

export type Labels = CrmLabels

interface LabelsContextType {
  labels: Labels
  updateLabels: (newLabels: Partial<Labels>) => Promise<void>
  refreshLabels: () => Promise<void>
  loading: boolean
}

const defaultLabels: Labels = DEFAULT_CRM_LABELS

const LabelsContext = createContext<LabelsContextType | undefined>(undefined)

export const LabelsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [labels, setLabels] = useState<Labels>(defaultLabels)
  const [loading, setLoading] = useState(true)
  const requestVersionRef = useRef(0)

  const fetchLabels = useCallback(async () => {
    let token: string | null = null
    try {
      token = localStorage.getItem('auth_token')
    } catch {
      token = null
    }

    if (!token) {
      setLoading(false)
      return
    }

    const requestVersion = ++requestVersionRef.current
    setLoading(true)
    try {
      const savedLabels = await crmLabelsService.get()
      if (requestVersion === requestVersionRef.current) {
        setLabels(normalizeCrmLabels(savedLabels))
      }
    } catch {
      // Una falla temporal conserva los últimos nombres válidos de la sesión.
    } finally {
      if (requestVersion === requestVersionRef.current) {
        setLoading(false)
      }
    }
  }, [])

  const updateLabels = async (newLabels: Partial<Labels>) => {
    const requestVersion = ++requestVersionRef.current
    const updatedLabels = normalizeCrmLabels({ ...labels, ...newLabels })
    setLoading(true)
    try {
      const savedLabels = await crmLabelsService.update(updatedLabels)
      if (requestVersion === requestVersionRef.current) {
        setLabels(normalizeCrmLabels(savedLabels))
      }
    } finally {
      if (requestVersion === requestVersionRef.current) {
        setLoading(false)
      }
    }
  }

  const refreshLabels = async () => {
    setLoading(true)
    await fetchLabels()
  }

  useEffect(() => {
    void fetchLabels()

    const handleAuthPrincipalChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ authenticated?: boolean }>).detail
      if (detail?.authenticated) {
        void fetchLabels()
        return
      }

      requestVersionRef.current += 1
      setLabels(defaultLabels)
      setLoading(false)
    }

    window.addEventListener(AUTH_PRINCIPAL_CHANGED_EVENT, handleAuthPrincipalChanged)
    return () => window.removeEventListener(AUTH_PRINCIPAL_CHANGED_EVENT, handleAuthPrincipalChanged)
  }, [fetchLabels])

  return (
    <LabelsContext.Provider value={{ labels, updateLabels, refreshLabels, loading }}>
      {children}
    </LabelsContext.Provider>
  )
}

export const useLabels = () => {
  const context = useContext(LabelsContext)
  if (context === undefined) {
    throw new Error('useLabels must be used within a LabelsProvider')
  }
  return context
}
