import React from 'react'
import { Card } from '../Card'
import { Users, UserCheck, Calendar, DollarSign, Layers, Target, MousePointerClick } from 'lucide-react'
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
}

export const ConversionFunnelChart: React.FC<ConversionFunnelChartProps> = ({
  data = [],
  loading = false,
  showVisitors = true,
  scope = 'all',
  onScopeChange
}) => {
  const { labels } = useLabels()

  const scopeOptions = [
    { value: 'all' as const, label: 'Todos', icon: Layers },
    { value: 'attribution' as const, label: 'Al registro', icon: Target },
    { value: 'campaigns' as const, label: 'Identificados de anuncios', icon: MousePointerClick }
  ]

  const DEFAULT_STAGES: FunnelStage[] = [
    { stage: 'Visitantes', value: 0, icon: Users },
    { stage: labels.leads, value: 0, icon: UserCheck },
    { stage: 'Citas', value: 0, icon: Calendar },
    { stage: labels.customers, value: 0, icon: DollarSign },
  ]
  const stageIconMap: Record<string, React.ComponentType<any>> = {
    visitantes: Users,
    leads: UserCheck,
    citas: Calendar,
    clientes: DollarSign
  }

  const getStageIcon = (stage: string, icon?: React.ComponentType<any>) => {
    if (icon) return icon
    const normalized = stage.trim().toLowerCase()
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

  return (
    <Card variant="glass" className={styles.container}>
      <div className={styles.header}>
        <h3 className={styles.title}>Conversiones</h3>
        {onScopeChange && (
          <div className={styles.scopeSelector}>
            {scopeOptions.map((option) => {
              const Icon = option.icon
              return (
                <button
                  key={option.value}
                  className={`${styles.scopeButton} ${scope === option.value ? styles.scopeButtonActive : ''}`}
                  onClick={() => onScopeChange(option.value)}
                  disabled={loading}
                >
                  <Icon size={14} />
                  <span>{option.label}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className={styles.funnelContainer}>
        {loading ? (
          <div className={styles.loadingList}>
            {[1, 2, 3, 4].map((i) => (
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

            return (
              <div key={item.stage} className={styles.stageContainer}>
                <div className={styles.stageContent}>
                  <div className={styles.iconContainer}>
                    <Icon className={styles.icon} />
                  </div>

                  <div className={styles.stageInfo}>
                    <div className={styles.stageHeader}>
                      <span className={styles.stageName}>{item.stage}</span>
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
                        style={{ width: `${percentage}%` }}
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
                {safeData[1]?.value > 0 ? ((safeData[2]?.value / safeData[1].value) * 100).toFixed(1) : '0'}%
              </span>
            </p>
          </div>
          <div className={styles.insightItem}>
            <p className={styles.insightLabel}>Citas → {labels.customers}</p>
            <p className={styles.insightValue}>
              <span className={styles.insightHighlight}>
                {safeData[2]?.value > 0 ? ((safeData[3]?.value / safeData[2].value) * 100).toFixed(1) : '0'}%
              </span>
            </p>
          </div>
          <div className={styles.insightItem}>
            <p className={styles.insightLabel}>Oportunidades perdidas</p>
            <p className={styles.insightValue}>
              {safeData[1]?.value > 0 ? (safeData[1].value - (safeData[2]?.value || 0)).toLocaleString() : '0'}
              <span className={styles.insightSubtext}> {labels.leads} sin cita</span>
            </p>
          </div>
        </div>
      )}
    </Card>
  )
}
