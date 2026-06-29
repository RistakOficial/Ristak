import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { ensureLocalDevAuth } from '@/services/authFetch'
import { apiUrl, requiresRuntimeApiBaseUrl, isNativeAppRuntime, clearRuntimeApiBaseUrl } from '@/services/apiBaseUrl'
import { getIntegrationsStatus } from '@/services/integrationsService'
import type { AccountLocaleDefaults } from '@/utils/accountLocale'
import type { AccessConfig, LicenseFeatures, UserRole } from '@/utils/accessControl'

export interface User {
  id: string
  name: string
  email: string
  role: UserRole
  tenant: string
  username?: string
  firstName?: string
  lastName?: string
  phone?: string
  businessName?: string
  accessConfig?: AccessConfig
  licenseEnforced?: boolean
  licensePlan?: string | null
  licenseFeatures?: LicenseFeatures
  licenseExternalModules?: Record<string, {
    key?: string
    label?: string
    menuLabel?: string
    enabled?: boolean
    sidebarPosition?: number | null
  }>
}

interface AuthContextType {
  user: User | null
  isAuthenticated: boolean
  login: (email: string, password: string) => Promise<void>
  setupAccount: (email: string, password: string, setupToken?: string, accountLocale?: AccountLocaleDefaults) => Promise<void>
  updateProfile: (profile: Partial<{
    firstName: string
    lastName: string
    phone: string
    businessName: string
  }>) => Promise<User>
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
    role: apiUser.role === 'admin' ? 'admin' : 'employee',
    tenant: 'Ristak',
    username: apiUser.username,
    firstName: apiUser.firstName || '',
    lastName: apiUser.lastName || '',
    phone: apiUser.phone || '',
    businessName: apiUser.businessName || '',
    accessConfig: apiUser.accessConfig || undefined,
    licenseEnforced: apiUser.licenseEnforced === true,
    licensePlan: apiUser.licensePlan || null,
    licenseFeatures: apiUser.licenseFeatures && typeof apiUser.licenseFeatures === 'object'
      ? apiUser.licenseFeatures
      : {},
    licenseExternalModules: apiUser.licenseExternalModules && typeof apiUser.licenseExternalModules === 'object'
      ? apiUser.licenseExternalModules
      : {}
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
      if (requiresRuntimeApiBaseUrl()) {
        localStorage.removeItem('auth_token')
        setUser(null)
        setNeedsSetup(false)
        setIsLoading(false)
        return
      }

      const checkSetupState = async () => {
        try {
          const response = await fetch(apiUrl('/api/auth/setup'))
          const data = await response.json()
          setNeedsSetup(data.needsSetup || false)
        } catch {
          setNeedsSetup(false)
        }
      }

      const verifyStoredToken = async (token: string) => {
        try {
          const response = await fetch(apiUrl('/api/auth/verify'), {
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
          // Se maneja igual que un token inválido.
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
        const data = await getIntegrationsStatus()

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

  const login = async (email: string, password: string) => {
    try {
      const response = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, password })
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

  const setupAccount = async (email: string, password: string, setupToken?: string, accountLocale?: AccountLocaleDefaults) => {
    try {
      const response = await fetch(apiUrl('/api/auth/setup'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, password, token: setupToken, accountLocale })
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

    const response = await fetch(apiUrl('/api/auth/profile'), {
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
    // (MOB-004) En la app móvil nativa, al cerrar sesión limpiamos también el tenant
    // runtime (base URL + storage tenant-scoped). Antes el logout dejaba la app apuntando
    // al backend de la empresa anterior, así que volver a entrar con un correo de OTRA
    // empresa fallaba. Ahora el siguiente login vuelve a resolver la empresa correcta.
    // En web es no-op (no hay tenant runtime; la API base la fija el host).
    if (isNativeAppRuntime()) {
      clearRuntimeApiBaseUrl()
    }
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
