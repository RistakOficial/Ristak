import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'

interface Labels {
  customer: string
  customers: string
  lead: string
  leads: string
}

interface LabelsContextType {
  labels: Labels
  updateLabels: (newLabels: Partial<Labels>) => Promise<void>
  refreshLabels: () => Promise<void>
  loading: boolean
}

const defaultLabels: Labels = {
  customer: 'Cliente',
  customers: 'Clientes',
  lead: 'Interesado',
  leads: 'Interesados'
}

const LabelsContext = createContext<LabelsContextType | undefined>(undefined)

export const LabelsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [labels, setLabels] = useState<Labels>(defaultLabels)
  const [loading, setLoading] = useState(true)

  const fetchLabels = async () => {
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || (import.meta.env.MODE === 'production' ? '' : 'http://localhost:3001')}/api/highlevel/custom-labels`)
      const json = await response.json()

      if (json.success && json.data) {
        setLabels(json.data)
      }
    } catch (error) {
      // Si falla, usar los valores por defecto
      console.error('Error loading custom labels:', error)
    } finally {
      setLoading(false)
    }
  }

  const updateLabels = async (newLabels: Partial<Labels>) => {
    try {
      const updatedLabels = { ...labels, ...newLabels }

      const response = await fetch(`${import.meta.env.VITE_API_URL || (import.meta.env.MODE === 'production' ? '' : 'http://localhost:3001')}/api/highlevel/custom-labels`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updatedLabels)
      })

      const json = await response.json()

      if (json.success && json.data) {
        setLabels(json.data)
      }
    } catch (error) {
      console.error('Error updating custom labels:', error)
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
