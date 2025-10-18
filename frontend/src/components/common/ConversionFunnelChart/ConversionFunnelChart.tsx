import React from 'react'
import { Card } from '../Card'
import { Users, UserCheck, Calendar, DollarSign } from 'lucide-react'
import styles from './ConversionFunnelChart.module.css'

interface FunnelStage {
  stage: string
  value: number
  icon?: React.ComponentType<any>
}

interface ConversionFunnelChartProps {
  data: FunnelStage[]
  loading?: boolean
}

const DEFAULT_STAGES: FunnelStage[] = [
  { stage: 'Visitantes', value: 0, icon: Users },
  { stage: 'Leads', value: 0, icon: UserCheck },
  { stage: 'Citas', value: 0, icon: Calendar },
  { stage: 'Clientes', value: 0, icon: DollarSign },
]

export const ConversionFunnelChart: React.FC<ConversionFunnelChartProps> = ({
  data = DEFAULT_STAGES,
  loading = false
}) => {
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

  const safeData = (data.length > 0 ? data : DEFAULT_STAGES).map((item) => ({
    ...item,
    icon: getStageIcon(item.stage, item.icon)
  }))

  const maxValue = safeData.length > 0 ? Math.max(...safeData.map(d => d.value), 1) : 1
  const totalConversion = safeData.length > 0 && safeData[0].value > 0
    ? ((safeData[safeData.length - 1].value / safeData[0].value) * 100).toFixed(1)
    : '0'

  return (
    <Card className={styles.container}>
      <div className={styles.header}>
        <div>
          <h3 className={styles.title}>Funnel de Conversión</h3>
        </div>
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

                {index < data.length - 1 && (
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
            <p className={styles.insightLabel}>Leads → Citas</p>
            <p className={styles.insightValue}>
              <span className={styles.insightHighlight}>
                {safeData[1]?.value > 0 ? ((safeData[2]?.value / safeData[1].value) * 100).toFixed(1) : '0'}%
              </span>
            </p>
          </div>
        </div>
      )}
    </Card>
  )
}
