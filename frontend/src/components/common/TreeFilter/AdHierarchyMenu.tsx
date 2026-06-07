import { useState } from 'react'
import { Target, Layers, Image as ImageIcon, Check, ChevronRight } from 'lucide-react'
import { Icon } from '../Icon/Icon'

interface AdHierarchyData {
  platform: string
  platform_id: string
  count: number
  campaigns: Array<{
    id: string
    name: string
    count: number
    adsets: Array<{
      id: string
      name: string
      count: number
      ads: Array<{
        id: string
        name: string
        count: number
      }>
    }>
  }>
}

interface AdHierarchyMenuProps {
  adsHierarchy: AdHierarchyData[]
  selectedFilters: Record<string, string[]>
  onFilterToggle: (field: string, value: string) => void
  onFilterChange?: (filters: Record<string, string[]>) => void
}

const getPlatformIcon = (platform?: string | null) => {
  const normalized = String(platform || '').toLowerCase()
  if (normalized.includes('instagram')) return 'instagram'
  if (normalized.includes('facebook')) return 'facebook'
  if (normalized.includes('tiktok')) return 'tiktok'
  if (normalized.includes('google')) return 'google'
  if (normalized.includes('youtube')) return 'youtube'
  if (normalized.includes('linkedin')) return 'linkedin'
  if (normalized.includes('twitter') || normalized === 'x') return 'twitter'
  if (normalized.includes('bing')) return 'bing'
  if (normalized.includes('whatsapp')) return 'whatsapp'
  if (normalized.includes('meta')) return 'meta-ads'
  return 'target'
}

const getPlatformColor = (platform?: string | null) => {
  const normalized = String(platform || '').toLowerCase()
  if (normalized.includes('instagram')) return '#e1306c'
  if (normalized.includes('facebook')) return '#1877f2'
  if (normalized.includes('tiktok')) return '#111827'
  if (normalized.includes('google')) return '#4285f4'
  if (normalized.includes('youtube')) return '#ff0000'
  if (normalized.includes('linkedin')) return '#0a66c2'
  if (normalized.includes('twitter') || normalized === 'x') return '#1d9bf0'
  if (normalized.includes('bing')) return '#008373'
  if (normalized.includes('whatsapp')) return '#25d366'
  if (normalized.includes('meta')) return '#0866ff'
  return 'currentColor'
}

export function AdHierarchyMenu({ adsHierarchy, selectedFilters, onFilterToggle, onFilterChange }: AdHierarchyMenuProps) {
  const [hoveredPlatform, setHoveredPlatform] = useState<string | null>(null)
  const [hoveredCampaign, setHoveredCampaign] = useState<string | null>(null)
  const [hoveredAdset, setHoveredAdset] = useState<string | null>(null)

  // Helpers para detectar selección
  const isPlatformSelected = (platformId: string) => {
    return selectedFilters.utm_source?.includes(platformId.toLowerCase())
  }

  const isCampaignSelected = (campaignId: string) => {
    return selectedFilters.utm_campaign?.includes(campaignId)
  }

  const isAdsetSelected = (adsetId: string) => {
    return selectedFilters.utm_medium?.includes(adsetId)
  }

  const isAdSelected = (adId: string) => {
    return selectedFilters.utm_content?.includes(adId)
  }

  // Función helper para manejar selección/deselección jerárquica
  const handleHierarchicalToggle = (level: 'platform' | 'campaign' | 'adset' | 'ad', value: string, parentIds?: { platform?: string; campaign?: string; adset?: string }) => {
    // Si no tenemos onFilterChange, usamos el método antiguo (fallback)
    if (!onFilterChange) {
      onFilterToggle(
        level === 'platform' ? 'utm_source' :
        level === 'campaign' ? 'utm_campaign' :
        level === 'adset' ? 'utm_medium' : 'utm_content',
        level === 'platform' ? value.toLowerCase() : value
      )
      return
    }

    // Crear una copia profunda del estado actual de filtros
    const newFilters: Record<string, string[]> = {
      utm_source: [...(selectedFilters.utm_source || [])],
      utm_campaign: [...(selectedFilters.utm_campaign || [])],
      utm_medium: [...(selectedFilters.utm_medium || [])],
      utm_content: [...(selectedFilters.utm_content || [])]
    }

    // Función helper para agregar un valor a un campo si no existe
    const addToFilter = (field: string, value: string) => {
      if (!newFilters[field]) newFilters[field] = []
      if (!newFilters[field].includes(value)) {
        newFilters[field].push(value)
      }
    }

    // Función helper para quitar un valor de un campo
    const removeFromFilter = (field: string, value: string) => {
      if (newFilters[field]) {
        newFilters[field] = newFilters[field].filter(v => v !== value)
      }
    }

    // Determinar si estamos agregando o quitando
    let isAdding = false

    if (level === 'platform') {
      const platformId = value.toLowerCase()
      isAdding = !isPlatformSelected(value)

      if (isAdding) {
        // Solo agregar la plataforma
        addToFilter('utm_source', platformId)
      } else {
        // Quitar plataforma y todos sus hijos
        removeFromFilter('utm_source', platformId)

        // Quitar todas las campañas, adsets y ads de esta plataforma
        const platform = adsHierarchy.find(p => p.platform_id === value)
        if (platform) {
          platform.campaigns.forEach(campaign => {
            removeFromFilter('utm_campaign', campaign.id)
            campaign.adsets.forEach(adset => {
              removeFromFilter('utm_medium', adset.id)
              adset.ads.forEach(ad => {
                removeFromFilter('utm_content', ad.id)
              })
            })
          })
        }
      }
    } else if (level === 'campaign') {
      isAdding = !isCampaignSelected(value)

      if (isAdding) {
        // Agregar la campaña Y su plataforma padre
        addToFilter('utm_campaign', value)
        if (parentIds?.platform) {
          addToFilter('utm_source', parentIds.platform.toLowerCase())
        }
      } else {
        // Quitar campaña y todos sus hijos
        removeFromFilter('utm_campaign', value)

        // Quitar todos los adsets y ads de esta campaña
        const platform = adsHierarchy.find(p => p.platform_id === parentIds?.platform)
        const campaign = platform?.campaigns.find(c => c.id === value)
        if (campaign) {
          campaign.adsets.forEach(adset => {
            removeFromFilter('utm_medium', adset.id)
            adset.ads.forEach(ad => {
              removeFromFilter('utm_content', ad.id)
            })
          })
        }
      }
    } else if (level === 'adset') {
      isAdding = !isAdsetSelected(value)

      if (isAdding) {
        // Agregar el adset Y todos sus padres
        addToFilter('utm_medium', value)
        if (parentIds?.campaign) {
          addToFilter('utm_campaign', parentIds.campaign)
        }
        if (parentIds?.platform) {
          addToFilter('utm_source', parentIds.platform.toLowerCase())
        }
      } else {
        // Quitar adset y todos sus hijos
        removeFromFilter('utm_medium', value)

        // Quitar todos los ads de este adset
        const platform = adsHierarchy.find(p => p.platform_id === parentIds?.platform)
        const campaign = platform?.campaigns.find(c => c.id === parentIds?.campaign)
        const adset = campaign?.adsets.find(a => a.id === value)
        if (adset) {
          adset.ads.forEach(ad => {
            removeFromFilter('utm_content', ad.id)
          })
        }
      }
    } else if (level === 'ad') {
      isAdding = !isAdSelected(value)

      if (isAdding) {
        // Agregar el ad Y TODOS sus padres (la magia de la jerarquía!)
        addToFilter('utm_content', value)
        if (parentIds?.adset) {
          addToFilter('utm_medium', parentIds.adset)
        }
        if (parentIds?.campaign) {
          addToFilter('utm_campaign', parentIds.campaign)
        }
        if (parentIds?.platform) {
          addToFilter('utm_source', parentIds.platform.toLowerCase())
        }
      } else {
        // Solo quitar el ad
        removeFromFilter('utm_content', value)
      }
    }

    // Limpiar campos vacíos
    Object.keys(newFilters).forEach(key => {
      if (!newFilters[key] || newFilters[key].length === 0) {
        delete newFilters[key]
      }
    })

    // Aplicar todos los cambios de una sola vez
    onFilterChange(newFilters)
  }

  // Obtener datos filtrados
  const activePlatform = adsHierarchy.find(p => p.platform_id === hoveredPlatform)
  const activeCampaign = activePlatform?.campaigns.find(c => c.id === hoveredCampaign)
  const activeAdset = activeCampaign?.adsets.find(a => a.id === hoveredAdset)

  return (
    <div className="flex">
      {/* Panel 1: utm_source */}
      <div className="w-64 overflow-y-auto relative" style={{ maxHeight: 'calc(100vh - 160px)', borderRight: '1px solid var(--color-border-subtle)' }}>
        <div className="px-3 py-2 mb-1" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">utm_source</h3>
        </div>
        <div className="py-2">
          {adsHierarchy.map((platform, index) => {
            const isSelected = isPlatformSelected(platform.platform_id)
            const isHovered = hoveredPlatform === platform.platform_id

            return (
              <div
                key={platform.platform_id}
                onMouseEnter={() => setHoveredPlatform(platform.platform_id)}
                onClick={() => handleHierarchicalToggle('platform', platform.platform_id)}
                data-ristak-dropdown-item
                data-active={isHovered ? 'true' : undefined}
                data-selected={isSelected ? 'true' : undefined}
                className={`
                  flex items-center gap-2 px-3 py-2 cursor-pointer transition-all duration-150
                  ${isSelected
                    ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25 !important'
                    : isHovered
                      ? 'bg-[var(--color-background-tertiary)] text-[var(--color-text-primary)]'
                      : 'hover:bg-[var(--color-background-tertiary)] text-[var(--color-text-primary)]'
                  }
                `}
                style={{ backgroundColor: !isSelected && !isHovered && index % 2 === 1 ? 'var(--table-row-even)' : undefined }}
              >
                <span className="w-4 h-4 flex items-center justify-center flex-shrink-0" style={{ color: getPlatformColor(platform.platform) }}>
                  <Icon name={getPlatformIcon(platform.platform)} size={16} />
                </span>

                {/* Label */}
                <span className="text-sm flex-1">{platform.platform}</span>

                {/* Count */}
                <span className="text-xs text-[var(--color-text-secondary)]">{platform.count}</span>

                <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
                  {isSelected && <Check className="w-4 h-4 stroke-[2.5] text-[var(--color-accent)]" />}
                </span>

                {/* Arrow si tiene campañas */}
                {platform.campaigns.length > 0 && (
                  <ChevronRight className="w-3 h-3 text-[var(--color-text-secondary)]" />
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Panel 2: utm_campaign (solo si hay platform hovered) */}
      {activePlatform && (
        <div className="w-64 overflow-y-auto relative" style={{ maxHeight: 'calc(100vh - 160px)', borderRight: '1px solid var(--color-border-subtle)' }}>
          <div className="px-3 py-2 mb-1" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">utm_campaign</h3>
          </div>
          <div className="py-2">
            {activePlatform.campaigns.map((campaign, index) => {
              const isSelected = isCampaignSelected(campaign.id)
              const isHovered = hoveredCampaign === campaign.id

              return (
                <div
                  key={campaign.id}
                  onMouseEnter={() => setHoveredCampaign(campaign.id)}
                  onClick={() => handleHierarchicalToggle('campaign', campaign.id, { platform: hoveredPlatform || undefined })}
                  data-ristak-dropdown-item
                  data-active={isHovered ? 'true' : undefined}
                  data-selected={isSelected ? 'true' : undefined}
                  className={`
                    flex items-center gap-2 px-3 py-2 cursor-pointer transition-all duration-150
                    ${isSelected
                      ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25 !important'
                      : isHovered
                        ? 'bg-[var(--color-background-tertiary)] text-[var(--color-text-primary)]'
                        : 'hover:bg-[var(--color-background-tertiary)] text-[var(--color-text-primary)]'
                    }
                  `}
                  style={{ backgroundColor: !isSelected && !isHovered && index % 2 === 1 ? 'var(--table-row-even)' : undefined }}
                >
                  <Target className="w-4 h-4 flex-shrink-0" />
                  <span className="text-sm flex-1">{campaign.name}</span>
                  <span className="text-xs text-[var(--color-text-secondary)]">{campaign.count}</span>

                  <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
                    {isSelected && <Check className="w-4 h-4 stroke-[2.5] text-[var(--color-accent)]" />}
                  </span>

                  {campaign.adsets.length > 0 && (
                    <ChevronRight className="w-3 h-3 text-[var(--color-text-secondary)]" />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Panel 3: utm_medium (solo si hay campaign hovered) */}
      {activeCampaign && (
        <div className="w-64 overflow-y-auto relative" style={{ maxHeight: 'calc(100vh - 160px)', borderRight: '1px solid var(--color-border-subtle)' }}>
          <div className="px-3 py-2 mb-1" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">utm_medium</h3>
          </div>
          <div className="py-2">
            {activeCampaign.adsets.map((adset, index) => {
              const isSelected = isAdsetSelected(adset.id)
              const isHovered = hoveredAdset === adset.id

              return (
                <div
                  key={adset.id}
                  onMouseEnter={() => setHoveredAdset(adset.id)}
                  onClick={() => handleHierarchicalToggle('adset', adset.id, { platform: hoveredPlatform || undefined, campaign: hoveredCampaign || undefined })}
                  data-ristak-dropdown-item
                  data-active={isHovered ? 'true' : undefined}
                  data-selected={isSelected ? 'true' : undefined}
                  className={`
                    flex items-center gap-2 px-3 py-2 cursor-pointer transition-all duration-150
                    ${isSelected
                      ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25 !important'
                      : isHovered
                        ? 'bg-[var(--color-background-tertiary)] text-[var(--color-text-primary)]'
                        : 'hover:bg-[var(--color-background-tertiary)] text-[var(--color-text-primary)]'
                    }
                  `}
                  style={{ backgroundColor: !isSelected && !isHovered && index % 2 === 1 ? 'var(--table-row-even)' : undefined }}
                >
                  <Layers className="w-4 h-4 flex-shrink-0" />
                  <span className="text-sm flex-1">{adset.name}</span>
                  <span className="text-xs text-[var(--color-text-secondary)]">{adset.count}</span>

                  <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
                    {isSelected && <Check className="w-4 h-4 stroke-[2.5] text-[var(--color-accent)]" />}
                  </span>

                  {adset.ads.length > 0 && (
                    <ChevronRight className="w-3 h-3 text-[var(--color-text-secondary)]" />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Panel 4: utm_content (solo si hay adset hovered) */}
      {activeAdset && (
        <div className="w-64 overflow-y-auto relative" style={{ maxHeight: 'calc(100vh - 160px)' }}>
          <div className="px-3 py-2 mb-1" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">utm_content</h3>
          </div>
          <div className="py-2">
            {activeAdset.ads.map((ad, index) => {
              const isSelected = isAdSelected(ad.id)

              return (
                <div
                  key={ad.id}
                  onClick={() => handleHierarchicalToggle('ad', ad.id, { platform: hoveredPlatform || undefined, campaign: hoveredCampaign || undefined, adset: hoveredAdset || undefined })}
                  data-ristak-dropdown-item
                  data-selected={isSelected ? 'true' : undefined}
                  className={`
                    flex items-center gap-2 px-3 py-2 cursor-pointer transition-all duration-150
                    ${isSelected
                      ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25 !important'
                      : 'hover:bg-[var(--color-background-tertiary)] text-[var(--color-text-primary)]'
                    }
                  `}
                  style={{ backgroundColor: !isSelected && index % 2 === 1 ? 'var(--table-row-even)' : undefined }}
                >
                  <ImageIcon className="w-4 h-4 flex-shrink-0" />
                  <span className="text-sm flex-1">{ad.name}</span>
                  <span className="text-xs text-[var(--color-text-secondary)]">{ad.count}</span>

                  <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
                    {isSelected && <Check className="w-4 h-4 stroke-[2.5] text-[var(--color-accent)]" />}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
