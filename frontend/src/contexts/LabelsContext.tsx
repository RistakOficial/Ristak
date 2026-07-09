import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { apiUrl } from '@/services/apiBaseUrl'
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

  const fetchLabels = async () => {
    try {
      const response = await fetch(apiUrl('/api/highlevel/custom-labels'))
      const json = await response.json()

      if (json.success && json.data) {
        setLabels(normalizeCrmLabels(json.data))
      }
    } catch (error) {
      // Si falla, usar los valores por defecto
    } finally {
      setLoading(false)
    }
  }

  const updateLabels = async (newLabels: Partial<Labels>) => {
    try {
      const updatedLabels = { ...labels, ...newLabels }

      const response = await fetch(apiUrl('/api/highlevel/custom-labels'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updatedLabels)
      })

      const json = await response.json()

      if (json.success && json.data) {
        setLabels(normalizeCrmLabels(json.data))
      }
    } catch (error) {
      throw error
    }
  }

  const refreshLabels = async () => {
    setLoading(true)
    await fetchLabels()
  }

  useEffect(() => {
    fetchLabels()
  }, [])

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
