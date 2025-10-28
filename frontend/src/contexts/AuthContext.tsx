import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'

const API_URL = import.meta.env.VITE_API_URL || ''

interface User {
  id: string
  name: string
  email: string
  role: 'admin' | 'manager' | 'viewer'
  tenant: string
  username?: string
}

interface AuthContextType {
  user: User | null
  isAuthenticated: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  locationId: string | null
  accessToken: string | null
  isLoading: boolean
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null)
  const [locationId, setLocationId] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Verificar si hay un token guardado al cargar la app
  useEffect(() => {
    const verifyToken = async () => {
      const token = localStorage.getItem('auth_token')

      if (!token) {
        setIsLoading(false)
        return
      }

      try {
        const response = await fetch(`${API_URL}/api/auth/verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ token })
        })

        if (response.ok) {
          const data = await response.json()
          if (data.success && data.user) {
            setUser({
              id: data.user.id,
              name: data.user.fullName || data.user.username,
              email: data.user.email || '',
              role: 'admin',
              tenant: 'Ristak',
              username: data.user.username
            })
          } else {
            localStorage.removeItem('auth_token')
          }
        } else {
          localStorage.removeItem('auth_token')
        }
      } catch {
        localStorage.removeItem('auth_token')
      } finally {
        setIsLoading(false)
      }
    }

    verifyToken()
  }, [])

  // Cargar datos del location de HighLevel una vez autenticado
  useEffect(() => {
    if (!user) return

    const fetchLocationData = async () => {
      try {
        const response = await fetch(`${API_URL}/api/integrations/status`)
        const data = await response.json()

        if (data.highlevel?.locationData) {
          const locationData = data.highlevel.locationData

          // Guardar locationId y accessToken para usar en otras partes de la app
          if (locationData.id) {
            setLocationId(locationData.id)
          }
        }

        // Guardar el accessToken si existe
        if (data.highlevel?.accessToken) {
          setAccessToken(data.highlevel.accessToken)
        }
      } catch (error) {
        // Si falla, continuar sin location data
      }
    }

    fetchLocationData()
  }, [user])

  const login = async (username: string, password: string) => {
    try {
      const response = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username, password })
      })

      const data = await response.json()

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Error en el login')
      }

      // Guardar token en localStorage
      localStorage.setItem('auth_token', data.token)

      // Actualizar estado del usuario
      setUser({
        id: data.user.id,
        name: data.user.fullName || data.user.username,
        email: data.user.email || '',
        role: 'admin',
        tenant: 'Ristak',
        username: data.user.username
      })
    } catch (error) {
      throw error
    }
  }

  const logout = () => {
    localStorage.removeItem('auth_token')
    setUser(null)
    setLocationId(null)
    setAccessToken(null)
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        login,
        logout,
        locationId,
        accessToken,
        isLoading
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
