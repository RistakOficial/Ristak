import React, { useState } from 'react'
import { Smartphone, Target, Layers, Image as ImageIcon, Check, ChevronRight } from 'lucide-react'

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
}

export function AdHierarchyMenu({ adsHierarchy, selectedFilters, onFilterToggle }: AdHierarchyMenuProps) {
  const [hoveredPlatform, setHoveredPlatform] = useState<string | null>(null)
  const [hoveredCampaign, setHoveredCampaign] = useState<string | null>(null)
  const [hoveredAdset, setHoveredAdset] = useState<string | null>(null)

  // Helpers para detectar selección
  const isPlatformSelected = (platformId: string) => {
    return selectedFilters.ad_platform?.includes(platformId.toLowerCase())
  }

  const isCampaignSelected = (campaignId: string) => {
    return selectedFilters.campaign_id?.includes(campaignId)
  }

  const isAdsetSelected = (adsetId: string) => {
    return selectedFilters.adset_id?.includes(adsetId)
  }

  const isAdSelected = (adId: string) => {
    return selectedFilters.ad_id?.includes(adId)
  }

  // Obtener datos filtrados
  const activePlatform = adsHierarchy.find(p => p.platform_id === hoveredPlatform)
  const activeCampaign = activePlatform?.campaigns.find(c => c.id === hoveredCampaign)
  const activeAdset = activeCampaign?.adsets.find(a => a.id === hoveredAdset)

  return (
    <div className="flex">
      {/* Panel 1: UTM Source */}
      <div className="w-64 overflow-y-auto relative" style={{ maxHeight: 'calc(100vh - 160px)', borderRight: '1px solid var(--color-border-subtle)' }}>
        <div className="px-3 py-2 mb-1" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">UTM Source</h3>
        </div>
        <div className="py-2">
          {adsHierarchy.map((platform, index) => {
            const isSelected = isPlatformSelected(platform.platform_id)
            const isHovered = hoveredPlatform === platform.platform_id

            return (
              <div
                key={platform.platform_id}
                onMouseEnter={() => setHoveredPlatform(platform.platform_id)}
                onClick={() => onFilterToggle('ad_platform', platform.platform_id.toLowerCase())}
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
                {/* Checkbox */}
                <div className={`
                  w-4 h-4 rounded transition-all duration-200 flex items-center justify-center flex-shrink-0
                  ${isSelected
                    ? 'bg-[var(--color-primary)] border-2 border-[var(--color-primary)]'
                    : 'bg-[var(--color-background-secondary)] border-2 border-[var(--color-border)] hover:border-[var(--color-primary)]'
                  }
                `}>
                  {isSelected && <Check className="w-3 h-3 stroke-[3]" style={{ color: '#ffffff' }} />}
                </div>

                {/* Icon */}
                <Smartphone className="w-4 h-4 flex-shrink-0" />

                {/* Label */}
                <span className="text-sm flex-1">{platform.platform}</span>

                {/* Count */}
                <span className="text-xs text-[var(--color-text-secondary)]">{platform.count}</span>

                {/* Arrow si tiene campañas */}
                {platform.campaigns.length > 0 && (
                  <ChevronRight className="w-3 h-3 text-[var(--color-text-secondary)]" />
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Panel 2: UTM Campaign (solo si hay platform hovered) */}
      {activePlatform && (
        <div className="w-64 overflow-y-auto relative" style={{ maxHeight: 'calc(100vh - 160px)', borderRight: '1px solid var(--color-border-subtle)' }}>
          <div className="px-3 py-2 mb-1" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">UTM Campaign</h3>
          </div>
          <div className="py-2">
            {activePlatform.campaigns.map((campaign, index) => {
              const isSelected = isCampaignSelected(campaign.id)
              const isHovered = hoveredCampaign === campaign.id

              return (
                <div
                  key={campaign.id}
                  onMouseEnter={() => setHoveredCampaign(campaign.id)}
                  onClick={() => onFilterToggle('campaign_id', campaign.id)}
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
                  <div className={`
                    w-4 h-4 rounded transition-all duration-200 flex items-center justify-center flex-shrink-0
                    ${isSelected
                      ? 'bg-[var(--color-primary)] border-2 border-[var(--color-primary)]'
                      : 'bg-[var(--color-background-secondary)] border-2 border-[var(--color-border)] hover:border-[var(--color-primary)]'
                    }
                  `}>
                    {isSelected && <Check className="w-3 h-3 stroke-[3]" style={{ color: '#ffffff' }} />}
                  </div>

                  <Target className="w-4 h-4 flex-shrink-0" />
                  <span className="text-sm flex-1">{campaign.name}</span>
                  <span className="text-xs text-[var(--color-text-secondary)]">{campaign.count}</span>

                  {campaign.adsets.length > 0 && (
                    <ChevronRight className="w-3 h-3 text-[var(--color-text-secondary)]" />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Panel 3: UTM Medium (solo si hay campaign hovered) */}
      {activeCampaign && (
        <div className="w-64 overflow-y-auto relative" style={{ maxHeight: 'calc(100vh - 160px)', borderRight: '1px solid var(--color-border-subtle)' }}>
          <div className="px-3 py-2 mb-1" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">UTM Medium</h3>
          </div>
          <div className="py-2">
            {activeCampaign.adsets.map((adset, index) => {
              const isSelected = isAdsetSelected(adset.id)
              const isHovered = hoveredAdset === adset.id

              return (
                <div
                  key={adset.id}
                  onMouseEnter={() => setHoveredAdset(adset.id)}
                  onClick={() => onFilterToggle('adset_id', adset.id)}
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
                  <div className={`
                    w-4 h-4 rounded transition-all duration-200 flex items-center justify-center flex-shrink-0
                    ${isSelected
                      ? 'bg-[var(--color-primary)] border-2 border-[var(--color-primary)]'
                      : 'bg-[var(--color-background-secondary)] border-2 border-[var(--color-border)] hover:border-[var(--color-primary)]'
                    }
                  `}>
                    {isSelected && <Check className="w-3 h-3 stroke-[3]" style={{ color: '#ffffff' }} />}
                  </div>

                  <Layers className="w-4 h-4 flex-shrink-0" />
                  <span className="text-sm flex-1">{adset.name}</span>
                  <span className="text-xs text-[var(--color-text-secondary)]">{adset.count}</span>

                  {adset.ads.length > 0 && (
                    <ChevronRight className="w-3 h-3 text-[var(--color-text-secondary)]" />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Panel 4: UTM Content (solo si hay adset hovered) */}
      {activeAdset && (
        <div className="w-64 overflow-y-auto relative" style={{ maxHeight: 'calc(100vh - 160px)' }}>
          <div className="px-3 py-2 mb-1" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">UTM Content</h3>
          </div>
          <div className="py-2">
            {activeAdset.ads.map((ad, index) => {
              const isSelected = isAdSelected(ad.id)

              return (
                <div
                  key={ad.id}
                  onClick={() => onFilterToggle('ad_id', ad.id)}
                  className={`
                    flex items-center gap-2 px-3 py-2 cursor-pointer transition-all duration-150
                    ${isSelected
                      ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25 !important'
                      : 'hover:bg-[var(--color-background-tertiary)] text-[var(--color-text-primary)]'
                    }
                  `}
                  style={{ backgroundColor: !isSelected && index % 2 === 1 ? 'var(--table-row-even)' : undefined }}
                >
                  <div className={`
                    w-4 h-4 rounded transition-all duration-200 flex items-center justify-center flex-shrink-0
                    ${isSelected
                      ? 'bg-[var(--color-primary)] border-2 border-[var(--color-primary)]'
                      : 'bg-[var(--color-background-secondary)] border-2 border-[var(--color-border)] hover:border-[var(--color-primary)]'
                    }
                  `}>
                    {isSelected && <Check className="w-3 h-3 stroke-[3]" style={{ color: '#ffffff' }} />}
                  </div>

                  <ImageIcon className="w-4 h-4 flex-shrink-0" />
                  <span className="text-sm flex-1">{ad.name}</span>
                  <span className="text-xs text-[var(--color-text-secondary)]">{ad.count}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
