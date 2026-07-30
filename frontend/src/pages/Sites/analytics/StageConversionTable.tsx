import { CircleHelp } from 'lucide-react'
import {
  Badge,
  HelpTooltip,
  Table,
  type BadgeVariant,
  type Column
} from '@/components/common'
import type {
  SitesStageFunnelAnalytics,
  SitesStageFunnelStage
} from '@/services/sitesService'
import { formatDateTime } from '@/utils/format'
import styles from './StageConversionTable.module.css'

interface StageConversionTableProps {
  analytics?: SitesStageFunnelAnalytics | null
  mode: 'funnel' | 'form'
  timezone?: string
}

const countFormatter = new Intl.NumberFormat('es-MX', {
  maximumFractionDigits: 0
})

const percentFormatter = new Intl.NumberFormat('es-MX', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
})

function formatCount(value: number | null | undefined): string {
  return countFormatter.format(Number.isFinite(value) ? Number(value) : 0)
}

function formatPercent(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return 'Sin dato'
  return `${percentFormatter.format(Number(value))}%`
}

function getCoveragePresentation(
  analytics?: SitesStageFunnelAnalytics | null
): { label: string; variant: BadgeVariant } {
  if (!analytics) {
    return { label: 'Sin datos de recorrido', variant: 'neutral' }
  }

  if (analytics.coverage.status === 'verified') {
    return { label: 'Cobertura completa', variant: 'success' }
  }

  if (analytics.coverage.status === 'partial') {
    return { label: 'Cobertura parcial', variant: 'warning' }
  }

  return { label: 'Sin cobertura verificable', variant: 'neutral' }
}

function StageHeader({
  label,
  help
}: {
  label: string
  help: string
}) {
  return (
    <HelpTooltip content={help}>
      <span className={styles.columnHeading} tabIndex={0}>
        {label}
        <CircleHelp size={13} aria-hidden="true" />
      </span>
    </HelpTooltip>
  )
}

function CountMetric({
  value,
  detail,
  tone
}: {
  value: number
  detail?: string
  tone?: 'loss'
}) {
  return (
    <div className={styles.countMetric} data-tone={tone}>
      <strong>{formatCount(value)}</strong>
      {detail ? <span>{detail}</span> : null}
    </div>
  )
}

function StageCell({
  stage,
  mode
}: {
  stage: SitesStageFunnelStage
  mode: StageConversionTableProps['mode']
}) {
  const fields = mode === 'form' ? stage.fields || [] : []
  const hasTerminalOutcome = stage.nextStages.length === 0 && stage.terminalAttempts > 0
  const stageKind = stage.kind === 'page'
    ? 'Página'
    : stage.kind === 'slide' ? 'Diapositiva' : 'Paso'

  return (
    <div className={styles.stageCell}>
      <div className={styles.stageIdentity}>
        <span className={styles.stageOrder}>{stage.order + 1}</span>
        <div>
          <div className={styles.stageTitleLine}>
            <strong>{stage.label}</strong>
            <Badge variant={hasTerminalOutcome ? 'primary' : 'neutral'}>
              {hasTerminalOutcome ? 'Terminación' : stageKind}
            </Badge>
          </div>
          {stage.terminalAttempts > 0 ? (
            <span className={styles.stageDetail}>
              {formatCount(stage.terminalAttempts)} intentos terminaron en esta etapa
            </span>
          ) : null}
        </div>
      </div>

      {fields.length ? (
        <div className={styles.fieldItems}>
          {fields.map(field => (
            <div key={field.fieldId} className={styles.fieldItem}>
              <span>{field.label}</span>
              <small>
                {formatCount(field.answeredAttempts)} intentos respondieron ·{' '}
                {formatCount(field.answeredVisitors)} identidades ·{' '}
                {stage.reachedAttempts > 0 ? formatPercent(field.answerRate) : 'Sin tasa'}
              </small>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function buildColumns(mode: StageConversionTableProps['mode']): Array<Column<SitesStageFunnelStage>> {
  const columns: Array<Column<SitesStageFunnelStage>> = [
    {
      key: 'label',
      header: 'Etapa',
      width: '34%',
      fixed: true,
      sortable: false,
      render: (_value, stage) => <StageCell stage={stage} mode={mode} />
    },
    {
      key: mode === 'funnel' ? 'totalViews' : 'reachedAttempts',
      header: (
        <StageHeader
          label={mode === 'funnel' ? 'Vistas' : 'Intentos'}
          help={mode === 'funnel'
            ? 'Todas las visualizaciones registradas para esta página, incluidas repeticiones.'
            : 'Intentos que llegaron a esta etapa, incluidas visitas repetidas de una misma identidad.'}
        />
      ),
      width: '11%',
      sortable: false,
      render: (_value, stage) => (
        <CountMetric
          value={mode === 'funnel'
            ? stage.totalViews ?? stage.reachedAttempts
            : stage.reachedAttempts}
          detail={stage.directEntries > 0
            ? `${formatCount(stage.directEntries)} directas`
            : undefined}
        />
      )
    },
    {
      key: 'reachedVisitors',
      header: (
        <StageHeader
          label="Únicos"
          help="Identidades first-party distintas que alcanzaron esta etapa. No equivale a personas verificadas."
        />
      ),
      width: '10%',
      sortable: false,
      render: (_value, stage) => (
        <CountMetric
          value={stage.reachedVisitors}
          detail={`${formatCount(stage.reachedAttempts)} intentos`}
        />
      )
    }
  ]

  if (mode === 'form') {
    columns.push({
      key: 'answeredVisitors',
      header: (
        <StageHeader
          label="Respondieron"
          help="Identidades que guardaron por lo menos una respuesta dentro de esta etapa."
        />
      ),
      width: '11%',
      sortable: false,
      render: (_value, stage) => (
        stage.answeredVisitors === undefined
          ? <span className={styles.emptyMetric}>—</span>
          : (
              <CountMetric
                value={stage.answeredVisitors}
                detail={`${formatCount(stage.answeredAttempts)} intentos`}
              />
            )
      )
    })
  }

  columns.push(
    {
      key: 'advancedVisitors',
      header: (
        <StageHeader
          label="Avance / final"
          help="Identidades que pasaron a otra etapa. Si el recorrido termina aquí, muestra los intentos terminales."
        />
      ),
      width: '12%',
      sortable: false,
      render: (_value, stage) => {
        const endedHere = (
          stage.terminalAttempts > 0 &&
          stage.advancedAttempts === 0 &&
          stage.nextStages.length === 0
        )

        return (
          <div className={styles.advanceMetric}>
            <CountMetric
              value={endedHere ? stage.terminalAttempts : stage.advancedVisitors}
              detail={endedHere
                ? 'intentos terminaron aquí'
                : `${formatCount(stage.advancedAttempts)} intentos`}
            />
            {stage.nextStages.length ? (
              <div className={styles.nextStageItems}>
                {stage.nextStages.map(nextStage => (
                  <span key={nextStage.stageId}>
                    A {nextStage.label}: {formatCount(nextStage.attempts)} intentos ·{' '}
                    {stage.reachedAttempts > 0 ? formatPercent(nextStage.rate) : 'Sin tasa'}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        )
      }
    },
    {
      key: 'advanceRate',
      header: (
        <StageHeader
          label="Tasa"
          help="Porcentaje de intentos que alcanzaron la etapa y después avanzaron."
        />
      ),
      width: '9%',
      sortable: false,
      render: (_value, stage) => {
        const endedHere = (
          stage.terminalAttempts > 0 &&
          stage.advancedAttempts === 0 &&
          stage.nextStages.length === 0
        )

        return (
          <Badge variant={endedHere ? 'neutral' : 'primary'} className={styles.rateValue}>
            {endedHere
              ? 'Final'
              : stage.reachedAttempts > 0 ? formatPercent(stage.advanceRate) : 'Sin dato'}
          </Badge>
        )
      }
    },
    {
      key: 'droppedVisitors',
      header: (
        <StageHeader
          label="No avanzaron"
          help="Abandono confirmado. Los intentos con actividad reciente permanecen separados como En curso."
        />
      ),
      width: '13%',
      sortable: false,
      render: (_value, stage) => (
        <CountMetric
          value={stage.droppedVisitors}
          detail={[
            `${formatCount(stage.droppedAttempts)} intentos`,
            stage.reachedAttempts > 0 ? formatPercent(stage.dropOffRate) : 'Sin tasa',
            `${formatCount(stage.inProgressVisitors)} identidades en curso (${formatCount(stage.inProgressAttempts)} intentos)`
          ].join(' · ')}
          tone={stage.droppedVisitors > 0 ? 'loss' : undefined}
        />
      )
    }
  )

  return columns
}

export function StageConversionTable({
  analytics,
  mode,
  timezone
}: StageConversionTableProps) {
  const coverage = getCoveragePresentation(analytics)
  const stages = analytics?.stages || []
  const title = mode === 'form'
    ? 'Conversión por etapa y pregunta'
    : 'Conversión página por página'
  const description = mode === 'form'
    ? 'Mide quién llegó, respondió, avanzó o abandonó cada paso del formulario.'
    : 'Mide cómo avanzan las identidades visitantes entre las páginas del embudo.'
  const trackedFrom = analytics?.coverage.trackedFrom
    ? formatDateTime(analytics.coverage.trackedFrom, {
        timezone,
        fallback: 'fecha no disponible'
      })
    : null
  const excludedRevisions = analytics?.coverage.excludedRevisions || 0
  const warnings = Array.from(new Set(analytics?.coverage.warnings || []))
    .filter(warning => !(
      excludedRevisions > 0 &&
      warning.includes(String(excludedRevisions)) &&
      warning.toLocaleLowerCase('es-MX').includes('exclu')
    ))

  return (
    <section className={styles.journeySection} aria-labelledby={`${mode}-journey-title`}>
      <div className={styles.journeyHeader}>
        <div>
          <h3 id={`${mode}-journey-title`}>{title}</h3>
          <p>{description}</p>
        </div>
        <Badge variant={coverage.variant}>{coverage.label}</Badge>
      </div>

      {analytics ? (
        <>
          <dl className={styles.summaryStrip}>
            <div>
              <dt>Entradas</dt>
              <dd>{formatCount(analytics.entrants)}</dd>
              <span>intentos</span>
            </div>
            <div>
              <dt>Visitantes únicos</dt>
              <dd>{formatCount(analytics.uniqueEntrants)}</dd>
              <span>identidades</span>
            </div>
            <div>
              <dt>Completaron</dt>
              <dd>{formatCount(analytics.completedVisitors)}</dd>
              <span>{formatCount(analytics.completedAttempts)} intentos</span>
            </div>
            <div>
              <dt>Conversión total</dt>
              <dd>
                {analytics.entrants > 0 ? formatPercent(analytics.conversionRate) : 'Sin dato'}
              </dd>
              <span>sobre intentos de entrada</span>
            </div>
          </dl>

          <div className={styles.methodNotes}>
            <p>
              <CircleHelp size={15} aria-hidden="true" />
              <span>
                <strong>Visitantes únicos</strong> son identidades first-party del navegador:
                una misma persona puede contar más de una vez si cambia de dispositivo o borra sus datos.
              </span>
            </p>
            <p>
              <CircleHelp size={15} aria-hidden="true" />
              <span>
                <strong>Abandono confirmado</strong> aparece cuando el intento permanece sin actividad
                durante 30 minutos. Antes de eso se mantiene como En curso.
              </span>
            </p>
          </div>

          {(trackedFrom || warnings.length > 0 || excludedRevisions > 0) ? (
            <div className={styles.coverageNotice} data-coverage={analytics.coverage.status}>
              <div>
                <strong>Alcance de la medición</strong>
                {trackedFrom ? <span>Disponible desde {trackedFrom}.</span> : null}
                {excludedRevisions > 0 ? (
                  <span>
                    {formatCount(excludedRevisions)} {excludedRevisions === 1 ? 'revisión distinta quedó' : 'revisiones distintas quedaron'} fuera
                    para no mezclar estructuras de recorrido.
                  </span>
                ) : null}
              </div>
              {warnings.length > 0 ? (
                <ul>
                  {warnings.map(warning => <li key={warning}>{warning}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div className={styles.dataSurface}>
            <Table
              columns={buildColumns(mode)}
              data={stages}
              keyExtractor={(stage) => stage.stageId}
              emptyMessage={mode === 'form'
                ? 'Todavía no hay etapas con recorrido verificable para este formulario.'
                : 'Todavía no hay páginas con recorrido verificable para este embudo.'}
              searchable={false}
              paginated={false}
              showColumnEditor={false}
            />
          </div>
        </>
      ) : (
        <div className={styles.emptyState}>
          <strong>Este recorrido todavía no tiene datos verificables</strong>
          <p>
            La analítica general sigue disponible. El detalle por etapa aparecerá cuando la medición
            first-party registre actividad compatible.
          </p>
        </div>
      )}
    </section>
  )
}
