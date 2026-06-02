import React from 'react'
import { Card } from '../Card'
import { HelpTooltip } from '../HelpTooltip'
import { Users, UserCheck, Calendar, DollarSign, Layers, Target, MousePointerClick, CheckCircle2, Eye, EyeOff } from 'lucide-react'
import { useLabels } from '@/contexts/LabelsContext'
import styles from './ConversionFunnelChart.module.css'

interface FunnelStage {
  stage: string
  value: number
  icon?: React.ComponentType<any>
}

type ScopeType = 'all' | 'attribution' | 'campaigns'

interface ConversionFunnelChartProps {
  data: FunnelStage[]
  loading?: boolean
  showVisitors?: boolean
  scope?: ScopeType
  onScopeChange?: (scope: ScopeType) => void
  onStageClick?: (stage: FunnelStage) => void
  onVisitorsVisibilityChange?: (showVisitors: boolean) => void
  visitorsVisibilityLoading?: boolean
}

export const ConversionFunnelChart: React.FC<ConversionFunnelChartProps> = ({
  data = [],
  loading = false,
  showVisitors = true,
  scope = 'all',
  onScopeChange,
  onStageClick,
  onVisitorsVisibilityChange,
  visitorsVisibilityLoading = false
}) => {
  const { labels } = useLabels()
  const visitorsToggleEnabled = Boolean(onVisitorsVisibilityChange)

  const scopeOptions = [
    {
      value: 'all' as const,
      label: 'Todos',
      icon: Layers,
      description: 'Incluye todas las conversiones del periodo usando la fecha real de cada etapa.'
    },
    {
      value: 'attribution' as const,
      label: 'Al registro',
      icon: Target,
      description: 'Acomoda las conversiones según la fecha en que se registró el contacto.'
    },
    {
      value: 'campaigns' as const,
      label: 'Identificados de anuncios',
      icon: MousePointerClick,
      description: 'Muestra solo contactos que pudieron vincularse a un anuncio identificado.'
    }
  ]

  const DEFAULT_STAGES: FunnelStage[] = [
    { stage: 'Visitantes', value: 0, icon: Users },
    { stage: labels.leads, value: 0, icon: UserCheck },
    { stage: 'Citas', value: 0, icon: Calendar },
    { stage: 'Asistencias', value: 0, icon: CheckCircle2 },
    { stage: labels.customers, value: 0, icon: DollarSign },
  ]
  const stageIconMap: Record<string, React.ComponentType<any>> = {
    visitantes: Users,
    leads: UserCheck,
    interesados: UserCheck,
    citas: Calendar,
    asistencias: CheckCircle2,
    clientes: DollarSign
  }

  const getStageIcon = (stage: string, icon?: React.ComponentType<any>) => {
    if (icon) return icon
    const normalized = stage.trim().toLowerCase()
    if (normalized === labels.leads.trim().toLowerCase()) return UserCheck
    if (normalized === labels.customers.trim().toLowerCase()) return DollarSign
    return stageIconMap[normalized] ?? Users
  }

  const baseData = data.length > 0 ? data : DEFAULT_STAGES
  const filteredData = showVisitors
    ? baseData
    : baseData.filter((item) => item.stage?.trim().toLowerCase() !== 'visitantes')
  const displayData = filteredData.length > 0
    ? filteredData
    : (showVisitors
      ? DEFAULT_STAGES
      : DEFAULT_STAGES.filter((item) => item.stage?.trim().toLowerCase() !== 'visitantes'))

  const safeData = displayData.map((item) => ({
    ...item,
    icon: getStageIcon(item.stage, item.icon)
  }))

  const maxValue = safeData.length > 0 ? Math.max(...safeData.map(d => d.value), 1) : 1
  const totalConversion = safeData.length > 0 && safeData[0].value > 0
    ? ((safeData[safeData.length - 1].value / safeData[0].value) * 100).toFixed(1)
    : '0'
  const getStageValue = (stageNames: string[]) => {
    const normalizedNames = stageNames.map(name => name.trim().toLowerCase())
    return safeData.find(item => normalizedNames.includes(item.stage.trim().toLowerCase()))?.value || 0
  }
  const leadsValue = getStageValue([labels.leads, 'leads', 'interesados'])
  const appointmentsValue = getStageValue(['citas'])
  const attendancesValue = getStageValue(['asistencias'])
  const customersValue = getStageValue([labels.customers, 'clientes', 'customers'])

  const updateVisitorsVisibility = (nextShowVisitors: boolean) => {
    if (visitorsVisibilityLoading) return
    onVisitorsVisibilityChange?.(nextShowVisitors)
  }

  return (
    <Card variant="glass" className={styles.container} data-ristak-chart="funnel">
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <h3 className={styles.title}>Conversiones</h3>
          {visitorsToggleEnabled && !showVisitors && (
            <button
              type="button"
              className={`${styles.visibilityButton} ${styles.titleVisibilityButton}`}
              onClick={() => updateVisitorsVisibility(true)}
              disabled={visitorsVisibilityLoading}
              aria-label="Mostrar visitantes"
              title="Mostrar visitantes"
            >
              <EyeOff size={16} />
            </button>
          )}
        </div>
        {onScopeChange && (
          <div className={styles.scopeSelector} data-ristak-scope-selector>
            {scopeOptions.map((option) => {
              const Icon = option.icon
              const button = (
                <button
                  className={`${styles.scopeButton} ${scope === option.value ? styles.scopeButtonActive : ''}`}
                  data-ristak-scope-button
                  data-active={scope === option.value ? 'true' : undefined}
                  onClick={() => onScopeChange(option.value)}
                  disabled={loading}
                >
                  <Icon size={14} />
                  <span>{option.label}</span>
                </button>
              )

              return (
                <HelpTooltip key={option.value} content={option.description}>
                  {button}
                </HelpTooltip>
              )
            })}
          </div>
        )}
      </div>

      <div className={styles.funnelContainer}>
        {loading ? (
          <div className={styles.loadingList}>
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className={styles.loadingItem}>
                <div className={styles.loadingIcon} />
                <div className={styles.loadingContent}>
                  <div className={styles.loadingBar} />
                  <div className={styles.loadingProgress} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          safeData.map((item, index) => {
            const percentage = maxValue > 0 ? (item.value / maxValue) * 100 : 0
            const conversionRate = index > 0 && safeData[index - 1].value > 0
              ? ((item.value / safeData[index - 1].value) * 100).toFixed(1)
              : '100'
            const Icon = item.icon ?? Users
            const isVisitorsStage = item.stage?.trim().toLowerCase() === 'visitantes'
            const isStageInteractive = Boolean(onStageClick)

            return (
              <div key={item.stage} className={styles.stageContainer}>
                <div
                  className={`${styles.stageContent} ${onStageClick ? styles.stageButton : ''}`}
                  onClick={() => onStageClick?.(item)}
                  role={isStageInteractive ? 'button' : undefined}
                  tabIndex={isStageInteractive ? 0 : undefined}
                  onKeyDown={(event) => {
                    if (!isStageInteractive) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onStageClick?.(item)
                    }
                  }}
                >
                  <div className={styles.iconContainer}>
                    <Icon className={styles.icon} />
                  </div>

                  <div className={styles.stageInfo}>
                    <div className={styles.stageHeader}>
                      <div className={styles.stageLabelGroup}>
                        <span className={styles.stageName}>{item.stage}</span>
                        {visitorsToggleEnabled && showVisitors && isVisitorsStage && (
                          <button
                            type="button"
                            className={`${styles.visibilityButton} ${styles.stageVisibilityButton}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              updateVisitorsVisibility(false)
                            }}
                            onKeyDown={(event) => event.stopPropagation()}
                            disabled={visitorsVisibilityLoading}
                            aria-label="Ocultar visitantes"
                            title="Ocultar visitantes"
                          >
                            <Eye size={15} />
                          </button>
                        )}
                      </div>
                      <div className={styles.stageValues}>
                        <span className={styles.stageValue}>
                          {item.value.toLocaleString()}
                        </span>
                        {index > 0 && (
                          <span className={styles.conversionRate}>
                            {conversionRate}%
                          </span>
                        )}
                      </div>
                    </div>

                    <div className={styles.progressBar}>
                      <div
                        className={styles.progressFill}
                        data-funnel-progress-fill
                        style={{
                          width: `${percentage}%`,
                          background: '#000000',
                          backgroundImage: 'none',
                          opacity: 1
                        }}
                      />
                    </div>
                  </div>
                </div>

                {index < safeData.length - 1 && (
                  <div className={styles.connector} />
                )}
              </div>
            )
          })
        )}
      </div>

      {!loading && safeData[0]?.value > 0 && (
        <div className={styles.insights}>
          <div className={styles.insightItem}>
            <p className={styles.insightLabel}>Conversión total</p>
            <p className={styles.insightValue}>
              <span className={styles.insightHighlight}>{totalConversion}%</span>
            </p>
          </div>
          <div className={styles.insightItem}>
            <p className={styles.insightLabel}>{labels.leads} → Citas</p>
            <p className={styles.insightValue}>
              <span className={styles.insightHighlight}>
                {leadsValue > 0 ? ((appointmentsValue / leadsValue) * 100).toFixed(1) : '0'}%
              </span>
            </p>
          </div>
          <div className={styles.insightItem}>
            <p className={styles.insightLabel}>Citas → Asistencias</p>
            <p className={styles.insightValue}>
              <span className={styles.insightHighlight}>
                {appointmentsValue > 0 ? ((attendancesValue / appointmentsValue) * 100).toFixed(1) : '0'}%
              </span>
            </p>
          </div>
          <div className={styles.insightItem}>
            <p className={styles.insightLabel}>Asistencias → {labels.customers}</p>
            <p className={styles.insightValue}>
              <span className={styles.insightHighlight}>
                {attendancesValue > 0 ? ((customersValue / attendancesValue) * 100).toFixed(1) : '0'}%
              </span>
            </p>
          </div>
        </div>
      )}
    </Card>
  )
}
