import apiClient from './apiClient'
import type { AccessConfig, UserRole } from '@/utils/accessControl'

export interface TeamUser {
  id: string
  username: string
  email: string
  phone: string
  firstName: string
  lastName: string
  fullName: string
  role: UserRole
  isActive: boolean
  lastLogin: string | null
  createdAt: string | null
  updatedAt: string | null
  accessConfig: AccessConfig
}

export interface SaveTeamUserInput {
  firstName: string
  lastName: string
  email: string
  phone: string
  role: UserRole
  password?: string
  accessConfig: AccessConfig
}

export interface TeamUserInvitation {
  id: string
  email: string
  phone: string
  firstName: string
  lastName: string
  fullName: string
  role: UserRole
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  expiresAt: string
  deliveredAt: string | null
  acceptedAt: string | null
  revokedAt: string | null
  createdAt: string
  accessConfig: AccessConfig
}

export type InviteTeamUserInput = Omit<SaveTeamUserInput, 'password'>

interface UsersResponse {
  success: boolean
  users: TeamUser[]
}

interface UserResponse {
  success: boolean
  user: TeamUser
}

interface InvitationsResponse {
  success: boolean
  invitations: TeamUserInvitation[]
}

interface InvitationResponse {
  success: boolean
  invitation: TeamUserInvitation
  delivery?: 'email'
  message?: string
}

export const userAccessService = {
  async listUsers() {
    const response = await apiClient.get<UsersResponse>('/auth/users')
    return response.users || []
  },

  async createUser(input: SaveTeamUserInput) {
    const response = await apiClient.post<UserResponse>('/auth/users', input)
    return response.user
  },

  async listInvitations() {
    const response = await apiClient.get<InvitationsResponse>('/auth/user-invitations')
    return response.invitations || []
  },

  async inviteUser(input: InviteTeamUserInput) {
    return apiClient.post<InvitationResponse>('/auth/user-invitations', input)
  },

  async revokeInvitation(invitationId: string) {
    return apiClient.delete<InvitationResponse>(`/auth/user-invitations/${invitationId}`)
  },

  async updateUser(userId: string, input: SaveTeamUserInput) {
    const response = await apiClient.patch<UserResponse>(`/auth/users/${userId}`, input)
    return response.user
  },

  async deleteUser(userId: string) {
    return apiClient.delete<{ success: boolean; deleted: boolean; userId: string }>(`/auth/users/${userId}`)
  }
}
