import { apiUrl } from './apiBaseUrl'

export interface MdpProgramNavItem {
  id: string
  label: string
  icon?: string
  order?: number
  path?: string
  launchUrl: string
}

export interface MdpProgramNavigation {
  configured: boolean
  program: {
    id: string
    title: string
  }
  user?: {
    id: string
    email: string
    name: string
  } | null
  items: MdpProgramNavItem[]
}

export async function getMdpProgramNavigation(): Promise<MdpProgramNavigation> {
  const response = await fetch(apiUrl('/api/mdp-program/navigation'))
  const data = await response.json().catch(() => ({}))

  if (!response.ok || data?.success === false) {
    throw new Error(data?.message || data?.error || 'No se pudo cargar Magnetismo de Pacientes.')
  }

  return {
    configured: data.configured === true,
    program: data.program || { id: 'mdp', title: 'Magnetismo de Pacientes' },
    user: data.user || null,
    items: Array.isArray(data.items)
      ? data.items
        .filter((item: Partial<MdpProgramNavItem>) => item?.id && item?.label && item?.launchUrl)
        .sort((a: MdpProgramNavItem, b: MdpProgramNavItem) => Number(a.order || 0) - Number(b.order || 0))
      : []
  }
}
