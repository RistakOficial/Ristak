import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { ensureLocalDevAuth } from '@/services/authFetch'

const API_URL = import.meta.env.VITE_API_URL || ''

interface User {
  id: string
  name: string
  email: string
  role: 'admin' | 'manager' | 'viewer'
  tenant: string
  username?: string
  firstName?: string
  lastName?: string
  phone?: string
  businessName?: string
}

interface AuthContextType {
  user: User | null
  isAuthenticated: boolean
  login: (username: string, password: string) => Promise<void>
  setupAccount: (username: string, password: string, setupToken?: string) => Promise<void>
  updateProfile: (profile: {
    firstName: string
    lastName: string
    phone: string
    businessName: string
  }) => Promise<User>
  logout: () => void
  locationId: string | null
  accessToken: string | null
  isLoading: boolean
  needsSetup: boolean
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

function mapUserFromApi(apiUser: any): User {
  return {
    id: apiUser.id,
    name: apiUser.fullName || apiUser.username,
    email: apiUser.email || '',
    role: 'admin',
    tenant: 'Ristak',
    username: apiUser.username,
    firstName: apiUser.firstName || '',
    lastName: apiUser.lastName || '',
    phone: apiUser.phone || '',
    businessName: apiUser.businessName || ''
  }
}

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null)
  const [locationId, setLocationId] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [needsSetup, setNeedsSetup] = useState(false)

  // Verificar si hay un token guardado al cargar la app
  useEffect(() => {
    const verifyToken = async () => {
      const checkSetupState = async () => {
        try {
          const response = await fetch(`${API_URL}/api/auth/setup`)
          const data = await response.json()
          setNeedsSetup(data.needsSetup || false)
        } catch {
          setNeedsSetup(false)
        }
      }

      const verifyStoredToken = async (token: string) => {
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
              setUser(mapUserFromApi(data.user))
              setNeedsSetup(false)
              return true
            }
          }
        } catch {
          // Se maneja igual que un token invalido.
        }

        localStorage.removeItem('auth_token')
        setNeedsSetup(false)
        return false
      }

      let token = localStorage.getItem('auth_token')

      if (!token && await ensureLocalDevAuth()) {
        token = localStorage.getItem('auth_token')
      }

      if (!token) {
        // Si no hay token, verificar si se necesita setup.
        await checkSetupState()
        setIsLoading(false)
        return
      }

      const tokenIsValid = await verifyStoredToken(token)
      if (!tokenIsValid && await ensureLocalDevAuth()) {
        const devToken = localStorage.getItem('auth_token')
        if (devToken) {
          await verifyStoredToken(devToken)
        }
      }

      setIsLoading(false)
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
        const error = new Error(data.message || 'Error en el login') as Error & { code?: string }
        error.code = data.code
        throw error
      }

      // Guardar token en localStorage
      localStorage.setItem('auth_token', data.token)
      if (data.apiToken) {
        sessionStorage.setItem('ristak_latest_api_token', data.apiToken)
      }

      // Actualizar estado del usuario
      setUser(mapUserFromApi(data.user))
      setNeedsSetup(false)
    } catch (error) {
      throw error
    }
  }

  const setupAccount = async (username: string, password: string, setupToken?: string) => {
    try {
      const response = await fetch(`${API_URL}/api/auth/setup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username, password, token: setupToken })
      })

      const data = await response.json()

      if (!response.ok || !data.success) {
        const error = new Error(data.message || 'Error al crear usuario') as Error & { code?: string }
        error.code = data.code
        throw error
      }

      // Guardar token en localStorage
      localStorage.setItem('auth_token', data.token)
      if (data.apiToken) {
        sessionStorage.setItem('ristak_latest_api_token', data.apiToken)
      }

      // Actualizar estado del usuario
      setUser(mapUserFromApi(data.user))
      setNeedsSetup(false)
    } catch (error) {
      throw error
    }
  }

  const updateProfile: AuthContextType['updateProfile'] = async (profile) => {
    const token = localStorage.getItem('auth_token')
    if (!token) {
      throw new Error('Vuelve a iniciar sesión para guardar tus datos.')
    }

    const response = await fetch(`${API_URL}/api/auth/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(profile)
    })

    const data = await response.json()

    if (!response.ok || !data.success || !data.user) {
      throw new Error(data.error || data.message || 'No se pudo guardar la información de la cuenta')
    }

    const nextUser = mapUserFromApi(data.user)
    setUser(nextUser)
    return nextUser
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
        setupAccount,
        updateProfile,
        logout,
        locationId,
        accessToken,
        isLoading,
        needsSetup
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
