import React, { useState, useEffect, useCallback } from 'react'
import { KpiCard, Card, DateRangePicker, Table, Icon, LineChart, ContactDetailsModal, PageContainer } from '@/components/common'
import type { Column } from '@/components/common'
import {
  RefreshCw,
  DollarSign,
  Megaphone,
  Target,
  TrendingUp,
  Users,
  ChevronRight,
  ChevronDown
} from 'lucide-react'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useLabels } from '@/contexts/LabelsContext'
import { formatCurrency, formatRoas, formatChartDate, formatDateToISO, parseLocalDateString } from '@/utils/format'
import { campaignsService, type CampaignContact } from '@/services/campaignsService'
import { reportsService, type CampaignsReport } from '@/services/reportsService'
import styles from './Campaigns.module.css'

interface AdData {
  id: string
  name: string
  spend: number
  reach?: number
  impressions?: number
  clicks: number
  visitors?: number
  leads?: number
  sales?: number
  revenue?: number
  roas?: number
  cpc?: number
  cpm?: number
}

interface AdSetData {
  id: string
  name: string
  spend: number
  reach?: number
  impressions?: number
  clicks: number
  visitors?: number
  leads?: number
  sales?: number
  revenue?: number
  roas?: number
  cpc?: number
  cpm?: number
  ads?: AdData[]
  isExpanded?: boolean
}

interface CampaignData {
  id: string
  name: string
  platform?: string
  spend: number
  reach?: number
  impressions?: number
  clicks: number
  visitors?: number
  leads?: number
  sales?: number
  revenue?: number
  roas?: number
  cpc?: number
  cpm?: number
  adsets?: AdSetData[]
  adSets?: AdSetData[]  // Keep both for compatibility
  isExpanded?: boolean
}

export const Campaigns: React.FC = () => {
  const { dateRange, setDateRange } = useDateRange()
  const { labels } = useLabels()
  const [campaigns, setCampaigns] = useState<CampaignData[]>([])
  const [loading, setLoading] = useState(true)
  const [syncStatus, setSyncStatus] = useState<any>(null)
  const [expandedCampaigns, setExpandedCampaigns] = useState<Set<string>>(new Set())
  const [expandedAdSets, setExpandedAdSets] = useState<Set<string>>(new Set())
  const [timeSeriesData, setTimeSeriesData] = useState<any[]>([])
  const [campaignSummary, setCampaignSummary] = useState<CampaignsReport['summary'] | null>(null)

  // Estados para modal de contactos
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [modalType, setModalType] = useState<'interesados' | 'sales'>('interesados')
  const [modalContacts, setModalContacts] = useState<CampaignContact[]>([])
  const [modalLoading, setModalLoading] = useState(false)
  const [modalTitle, setModalTitle] = useState('')
  const [selectedModalItem, setSelectedModalItem] = useState<any>(null)

  const fetchCampaigns = useCallback(async () => {
    try {
      setLoading(true)
      const startDate = formatDateToISO(dateRange.start)
      const endDate = formatDateToISO(dateRange.end)

      const summaryPromise = reportsService
        .getCampaignsReport({ from: startDate, to: endDate })
        .catch(() => null as CampaignsReport | null)

      const [campaignsData, spendData, summaryReport] = await Promise.all([
        campaignsService.getCampaigns(startDate, endDate),
        campaignsService.getSpendOverTime(startDate, endDate),
        summaryPromise
      ])

      // Transform the data to match our interface
      const transformedData = campaignsData.map(campaign => ({
        ...campaign,
        platform: 'Meta', // All campaigns from Meta
        adSets: campaign.adsets, // Map adsets to adSets for compatibility
        adsets: campaign.adsets, // Keep both for compatibility
        visitors: campaign.clicks || 0, // Use clicks as visitors for now
        revenue: campaign.revenue || 0,
        sales: campaign.sales || 0,
        leads: campaign.leads || 0,
        roas: campaign.roas || (campaign.revenue && campaign.spend ? campaign.revenue / campaign.spend : 0)
      }))

      // Ordenar campañas de más reciente a más vieja (por ID descendente)
      const sortedData = transformedData.sort((a, b) => {
        // Los IDs de Meta son números grandes como strings
        const idA = parseInt(a.id) || 0
        const idB = parseInt(b.id) || 0
        return idB - idA // Descendente: más reciente primero
      })

      setCampaigns(sortedData)
      setCampaignSummary(summaryReport?.summary ?? null)

      // Calcular rango en días
      const rangeInDays = Math.ceil((dateRange.end.getTime() - dateRange.start.getTime()) / (1000 * 60 * 60 * 24))

      // Formatear fechas inteligentemente para el gráfico
      const formattedSpendData = spendData.map((item, index) => ({
        ...item,
        label: formatChartDate(item.label, rangeInDays, index > 0 ? spendData[index - 1].label : undefined)
      }))

      // Use real spend data for chart with smart date formatting
      setTimeSeriesData(formattedSpendData)
    } catch (error) {
      // Don't fall back to mock data - show empty state
      setCampaigns([])
      setCampaignSummary(null)
      setTimeSeriesData([])
  } finally {
    setLoading(false)
  }
  }, [dateRange.start, dateRange.end])

  // Fetch campaigns on mount and when date range changes
  useEffect(() => {
    fetchCampaigns()
  }, [fetchCampaigns])

  const checkSyncStatus = useCallback(async () => {
    try {
      const status = await campaignsService.getSyncStatus()

      // Si no hay status o no está corriendo
      if (!status || !status.running) {
        // Si había una sincronización corriendo y ahora terminó
        setSyncStatus((prevStatus: any) => {
          if (prevStatus?.running) {
            fetchCampaigns()
            return null
          }
          return prevStatus
        })
        return
      }

      // Si está corriendo, siempre actualizar para mostrar progreso
      setSyncStatus(status)
    } catch (error) {
      // Silenciar errores de polling
    }
  }, [fetchCampaigns])

  // Poll sync status periodically
  useEffect(() => {
    // Initial check
    checkSyncStatus()

    // Poll every 2 seconds
    const intervalId = setInterval(() => {
      checkSyncStatus()
    }, 2000)

    return () => {
      clearInterval(intervalId)
    }
  }, [checkSyncStatus])

  const handleOpenContactsModal = useCallback(async (item: any, type: 'interesados' | 'sales') => {
    setModalLoading(true)
    setIsModalOpen(true)
    setModalType(type)
    setModalTitle(`${type === 'interesados' ? labels.leads : 'Ventas'} - ${item.name}`)
    setModalContacts([])
    setSelectedModalItem(item)

    try {
      const startDate = formatDateToISO(dateRange.start)
      const endDate = formatDateToISO(dateRange.end)

      const params: any = {
        type,
        startDate,
        endDate
      }

      if (item.level === 'campaign') {
        params.campaign_id = item.id
      } else if (item.level === 'adset') {
        params.adset_id = item.id
      } else if (item.level === 'ad') {
        params.ad_id = item.id
      }

      const contacts = await campaignsService.getContactsByType(params)
      setModalContacts(contacts)
    } catch (error) {
      setModalContacts([])
    } finally {
      setModalLoading(false)
    }
  }, [dateRange, labels])

  // Recargar datos del modal cuando cambian las fechas
  useEffect(() => {
    if (isModalOpen && selectedModalItem) {
      handleOpenContactsModal(selectedModalItem, modalType)
    }
  }, [dateRange, isModalOpen, selectedModalItem, modalType, handleOpenContactsModal])

  const handleExport = () => {
    // TODO: Implementar exportación
  }

  const toggleCampaign = useCallback((campaignId: string) => {
    // Asegurar que el ID sea string
    const id = String(campaignId)

    setExpandedCampaigns(prev => {
      const newSet = new Set(prev)

      if (newSet.has(id)) {
        // Colapsar campaña
        newSet.delete(id)

        // También colapsar todos sus AdSets
        const campaign = campaigns.find(c => String(c.id) === id)
        if (campaign?.adsets && Array.isArray(campaign.adsets)) {
          setExpandedAdSets(prevAdSets => {
            const newAdSets = new Set(prevAdSets)
            campaign.adsets?.forEach((adSet: any) => {
              newAdSets.delete(String(adSet.id))
            })
            return newAdSets
          })
        }
      } else {
        // Expandir campaña
        newSet.add(id)
      }

      return newSet
    })
  }, [campaigns])

  const toggleAdSet = useCallback((adSetId: string) => {
    // Asegurar que el ID sea string
    const id = String(adSetId)

    setExpandedAdSets(prev => {
      const newSet = new Set(prev)

      if (newSet.has(id)) {
        newSet.delete(id)
      } else {
        newSet.add(id)
      }

      return newSet
    })
  }, [])

  // Preparar datos planos para la tabla
  const getFlattenedData = () => {
    const flatData: any[] = []

    campaigns.forEach(campaign => {
      // Convertir IDs a strings para consistencia
      const campaignId = String(campaign.id)
      const adSetsData = campaign.adsets || []
      const isExpanded = expandedCampaigns.has(campaignId)

      // Agregar campaña (si está expandida, mostrar placeholder)
      flatData.push({
        ...campaign,
        id: campaignId, // Asegurar que el ID sea string
        level: 'campaign',
        hasChildren: adSetsData.length > 0,
        isExpanded: isExpanded,
        showPlaceholder: isExpanded && adSetsData.length > 0
      })

      // Si la campaña está expandida, agregar AdSets
      if (isExpanded && adSetsData.length > 0) {
        adSetsData.forEach((adSet: any) => {
          const adSetId = String(adSet.id)
          const adSetExpanded = expandedAdSets.has(adSetId)
          const adsData = adSet.ads || []

          // Agregar AdSet (si está expandido, mostrar placeholder)
          flatData.push({
            ...adSet,
            id: adSetId, // Asegurar que el ID sea string
            level: 'adset',
            campaignId: campaignId,
            hasChildren: adsData.length > 0,
            isExpanded: adSetExpanded,
            showPlaceholder: adSetExpanded && adsData.length > 0
          })

          // Si el AdSet está expandido, agregar Ads
          if (adSetExpanded && adsData.length > 0) {
            adsData.forEach((ad: any) => {
              flatData.push({
                ...ad,
                id: String(ad.id), // Asegurar que el ID sea string
                level: 'ad',
                campaignId: campaignId,
                adSetId: adSetId,
                hasChildren: false,
                showPlaceholder: false
              })
            })
          }
        })
      }
    })

    return flatData
  }

  const columns: Column<any>[] = [
    {
      key: 'name',
      header: 'Nombre',
      fixed: true,
      visible: true,
      render: (value, item) => {
        const indentStyle = {
          paddingLeft: item.level === 'adset' ? '40px' : item.level === 'ad' ? '60px' : '20px'
        }

        const handleToggle = (e: React.MouseEvent) => {
          e.stopPropagation()

          if (!item.hasChildren) return

          if (item.level === 'campaign') {
            toggleCampaign(item.id)
          } else if (item.level === 'adset') {
            toggleAdSet(item.id)
          }
        }

        return (
          <div
            className={`${styles.nameCell} ${item.hasChildren ? styles.clickableName : ''}`}
            style={indentStyle}
            onClick={handleToggle}
          >
            {item.hasChildren && (
              <button
                className={styles.expandButton}
                onClick={handleToggle}
                aria-label={item.isExpanded ? 'Colapsar' : 'Expandir'}
              >
                {item.isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
            )}
            <div className={styles.nameContent}>
              {item.level === 'campaign' && item.platform && (
                <Icon
                  name={item.platform.toLowerCase()}
                  size={16}
                  className={styles.campaignIcon}
                />
              )}
              <strong className={`${styles.nameText} ${styles[item.level]}`}>
                {value}
              </strong>
            </div>
          </div>
        )
      },
      sortable: false,
      width: '30%'
    },
    {
      key: 'roas',
      header: 'Retorno de Inversión',
      visible: true,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>
        const roasValue = value || 0
        return (
          <span className={roasValue >= 3 ? styles.goodRoas : styles.lowRoas}>
            {formatRoas(roasValue)}
          </span>
        )
      },
      sortable: true,
      width: '8%'
    },
    {
      key: 'revenue',
      header: 'Ingresos',
      visible: true,
      render: (value, item) => item.showPlaceholder ?
        <span className={styles.placeholderText}>—</span> :
        formatCurrency(value || 0),
      sortable: true,
      width: '10%'
    },
    {
      key: 'spend',
      header: 'Inversión',
      visible: true,
      render: (value, item) => item.showPlaceholder ?
        <span className={styles.placeholderText}>—</span> :
        formatCurrency(value),
      sortable: true,
      width: '10%'
    },
    {
      key: 'leads',
      header: labels.leads,
      visible: true,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>

        const hasLeads = (value || 0) > 0

        return (
          <span
            className={hasLeads ? styles.clickableNumber : ''}
            onClick={(e) => {
              if (hasLeads) {
                e.stopPropagation()
                handleOpenContactsModal(item, 'interesados')
              }
            }}
          >
            {value || 0}
          </span>
        )
      },
      sortable: true,
      width: '7%'
    },
    {
      key: 'sales',
      header: `Nuevo ${labels.customer}`,
      visible: true,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>

        const hasSales = (value || 0) > 0

        return (
          <span
            className={hasSales ? styles.clickableNumber : ''}
            onClick={(e) => {
              if (hasSales) {
                e.stopPropagation()
                handleOpenContactsModal(item, 'sales')
              }
            }}
          >
            {value || 0}
          </span>
        )
      },
      sortable: true,
      width: '7%'
    },
    {
      key: 'reach',
      header: 'Alcance',
      visible: false,
      render: (value, item) => item.showPlaceholder ?
        <span className={styles.placeholderText}>—</span> :
        (value || 0).toLocaleString(),
      sortable: true,
      width: '8%'
    },
    {
      key: 'clicks',
      header: 'Clicks',
      visible: false,
      render: (value, item) => item.showPlaceholder ?
        <span className={styles.placeholderText}>—</span> :
        (value || 0).toLocaleString(),
      sortable: true,
      width: '8%'
    },
    {
      key: 'cpc',
      header: 'Costo por Clic',
      visible: false,
      render: (value, item) => item.showPlaceholder ?
        <span className={styles.placeholderText}>—</span> :
        formatCurrency(value || 0),
      sortable: true,
      width: '8%'
    },
    {
      key: 'visitors',
      header: 'Visitantes',
      visible: false,
      render: (value, item) => item.showPlaceholder ?
        <span className={styles.placeholderText}>—</span> :
        (value || 0).toLocaleString(),
      sortable: true,
      width: '8%'
    },
    {
      key: 'cpl',
      header: `Costo por ${labels.lead}`,
      visible: false,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>
        const cpl = (item.leads || 0) > 0 ? item.spend / item.leads : 0
        return formatCurrency(cpl)
      },
      sortable: true,
      width: '8%'
    },
    {
      key: 'cac',
      header: `Costo por ${labels.customer}`,
      visible: false,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>
        const cac = (item.sales || 0) > 0 ? item.spend / item.sales : 0
        return formatCurrency(cac)
      },
      sortable: true,
      width: '8%'
    },
    {
      key: 'appointments',
      header: 'Citas',
      visible: false,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>
        return (value || 0).toLocaleString()
      },
      sortable: true,
      width: '7%'
    },
    {
      key: 'webToLeadsRate',
      header: `Alcance → ${labels.leads} %`,
      visible: false,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>
        const rate = (item.reach || 0) > 0 ? ((item.leads || 0) / item.reach) * 100 : 0
        return <span>{rate.toFixed(1)}%</span>
      },
      sortable: true,
      width: '10%'
    },
    {
      key: 'leadsToApptsRate',
      header: `${labels.leads} → Citas %`,
      visible: false,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>
        const appointments = item.appointments || 0
        const rate = (item.leads || 0) > 0 ? (appointments / item.leads) * 100 : 0
        return <span>{rate.toFixed(1)}%</span>
      },
      sortable: true,
      width: '10%'
    },
    {
      key: 'apptsToSalesRate',
      header: `Citas → ${labels.customers} %`,
      visible: false,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>
        const appointments = item.appointments || 0
        const rate = appointments > 0 ? ((item.sales || 0) / appointments) * 100 : 0
        return <span>{rate.toFixed(1)}%</span>
      },
      sortable: true,
      width: '10%'
    }
  ]

  const totals = React.useMemo(() => {
    if (campaignSummary) {
      return {
        revenue: campaignSummary.revenue,
        spend: campaignSummary.spend,
        sales: campaignSummary.sales,
        leads: campaignSummary.leads
      }
    }

    return campaigns.reduce((acc, campaign) => ({
      revenue: acc.revenue + (campaign.revenue || 0),
      spend: acc.spend + (campaign.spend || 0),
      sales: acc.sales + (campaign.sales || 0),
      leads: acc.leads + (campaign.leads || 0)
    }), { revenue: 0, spend: 0, sales: 0, leads: 0 })
  }, [campaignSummary, campaigns])

  const avgRoas = React.useMemo(() => {
    if (campaignSummary) {
      return campaignSummary.roas || 0
    }
    return totals.spend > 0 ? totals.revenue / totals.spend : 0
  }, [campaignSummary, totals.revenue, totals.spend])

  const calculateDelta = React.useCallback((current: number, previous: number) => {
    if (previous === 0) {
      return current > 0 ? 100 : 0
    }
    const delta = ((current - previous) / Math.abs(previous)) * 100
    return Number.isFinite(delta) ? delta : 0
  }, [])

  const campaignDeltas = React.useMemo(() => {
    if (!campaignSummary) {
      return {
        revenue: 0,
        spend: 0,
        roas: 0,
        sales: 0,
        leads: 0
      }
    }

    return {
      revenue: calculateDelta(campaignSummary.revenue, campaignSummary.revenuePrev),
      spend: calculateDelta(campaignSummary.spend, campaignSummary.spendPrev),
      roas: calculateDelta(campaignSummary.roas || 0, campaignSummary.roasPrev || 0),
      sales: calculateDelta(campaignSummary.sales, campaignSummary.salesPrev),
      leads: calculateDelta(campaignSummary.leads, campaignSummary.leadsPrev)
    }
  }, [campaignSummary, calculateDelta])

  return (
    <PageContainer>
      <div className={styles.container}>
        <div className={styles.pageHeader}>
          <div>
            <h1 className={styles.pageTitle}>Publicidad</h1>
            <p className={styles.pageSubtitle}>Analiza el rendimiento de tus campañas y sus indicadores clave.</p>
          </div>
          <div className={styles.datePickerWrapper}>
            <DateRangePicker
              startDate={formatDateToISO(dateRange.start instanceof Date ? dateRange.start : new Date(dateRange.start))}
              endDate={formatDateToISO(dateRange.end instanceof Date ? dateRange.end : new Date(dateRange.end))}
              onChange={(start, end) => setDateRange({
                start: parseLocalDateString(start),
                end: parseLocalDateString(end),
                preset: 'custom' as const
              })}
            />
          </div>
        </div>

        {/* Sync Status Banner - Rediseñado */}
        {syncStatus && syncStatus.running && (
          <div className={styles.syncBanner}>
            <div className={styles.syncHeader}>
              <div className={styles.syncIconWrapper}>
                <RefreshCw size={20} className={styles.syncIcon} />
              </div>
              <div className={styles.syncTextWrapper}>
                <div className={styles.syncTitle}>Sincronizando campañas</div>
                <div className={styles.syncSubtitle}>
                  {syncStatus.currentMonth ? `Procesando ${syncStatus.currentMonth}` : (syncStatus.message || 'Preparando sincronización...')}
                </div>
              </div>
            </div>

            {syncStatus.total > 0 ? (
              <div className={styles.syncProgressSection}>
                <div className={styles.syncProgressBar}>
                  <div
                    className={styles.syncProgressFill}
                    style={{ width: `${Math.round((syncStatus.processed / syncStatus.total) * 100)}%` }}
                  />
                </div>
                <div className={styles.syncStats}>
                  <span className={styles.syncStat}>
                    {syncStatus.processed} / {syncStatus.total} períodos
                  </span>
                  {syncStatus.totalRecords > 0 && (
                    <span className={styles.syncStat}>
                      {syncStatus.totalRecords.toLocaleString()} registros
                    </span>
                  )}
                  <span className={styles.syncPercentage}>
                    {Math.round((syncStatus.processed / syncStatus.total) * 100)}%
                  </span>
                </div>
              </div>
            ) : (
              <div className={styles.syncProgressSection}>
                <div className={styles.syncSubtitle} style={{ textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: '13px' }}>
                  {syncStatus.message || 'Iniciando...'}
                </div>
              </div>
            )}
          </div>
        )}

        <div className={styles.kpiRow}>
          <KpiCard
            title="Ingresos"
            value={formatCurrency(totals.revenue)}
            delta={campaignDeltas.revenue}
            deltaLabel="vs periodo anterior"
            icon={<DollarSign size={20} />}
          />
          <KpiCard
            title="Inversión Total"
            value={formatCurrency(totals.spend)}
            delta={campaignDeltas.spend}
            deltaLabel="vs periodo anterior"
            icon={<Megaphone size={20} />}
          />
          <KpiCard
            title="Retorno de Inversión Promedio"
            value={formatRoas(avgRoas)}
            delta={campaignDeltas.roas}
            deltaLabel="vs periodo anterior"
            icon={<TrendingUp size={20} />}
          />
          <KpiCard
            title={`Nuevos ${labels.customers}`}
            value={totals.sales.toString()}
            delta={campaignDeltas.sales}
            deltaLabel="vs periodo anterior"
            icon={<Target size={20} />}
          />
          <KpiCard
            title={labels.leads}
            value={totals.leads.toString()}
            delta={campaignDeltas.leads}
            deltaLabel="vs periodo anterior"
            icon={<Users size={20} />}
          />
        </div>

        <Card className={styles.chartCard}>
          <h2 className={styles.chartTitle}>Ingresos vs Gastos de Publicidad</h2>
          <div style={{ height: 300 }}>
            {timeSeriesData.length > 0 ? (
              <LineChart
                data={timeSeriesData}
                height={300}
                showGrid={true}
                color="#10b981"
                color2="#64748b"
                formatValue={(v) => `$${(v / 1000).toFixed(1)}k`}
                showLegend={true}
                legendLabels={{ label1: 'Ingresos', label2: 'Gastos Publicidad' }}
              />
            ) : (
              <div className="flex h-full items-center justify-center rounded-xl border border-[rgba(148,163,184,0.18)] bg-[color-mix(in_srgb,var(--color-background-glass) 82%, transparent)] text-sm text-[var(--color-text-tertiary)]">
                Sin datos de campañas disponibles
              </div>
            )}
          </div>
        </Card>

      <Card padding="none">
        <Table
          key="campaigns_table"
          initialColumns={columns}
          data={getFlattenedData()}
          keyExtractor={(item) => `${item.level}_${item.id}_${item.campaignId || ''}_${item.adSetId || ''}`}
          emptyMessage="No hay campañas disponibles"
          loading={loading}
          searchable={true}
          searchPlaceholder="Buscar campañas..."
          paginated={true}
          pageSize={50}
          exportable={true}
          onExport={handleExport}
          tableId="campaigns"
        />
      </Card>

      {/* Modal de contactos */}
      <ContactDetailsModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false)
          setSelectedModalItem(null)
        }}
        title={modalTitle}
        subtitle={modalContacts.length === 0
          ? 'Sin datos para este periodo'
          : `${modalContacts.length} ${modalType === 'interesados' ? labels.leads.toLowerCase() : labels.customers.toLowerCase()}`}
        data={modalContacts}
        loading={modalLoading}
        type={modalType}
      />
      </div>
    </PageContainer>
  )
}
