import React from 'react'
import { X } from 'lucide-react'
import { Button } from '../Button'
import styles from './Table.module.css'

interface TableSelectionToolbarProps {
  count: number
  singularLabel?: string
  pluralLabel?: string
  children: React.ReactNode
  onClearSelection?: () => void
  clearLabel?: string
}

export const TableSelectionToolbar: React.FC<TableSelectionToolbarProps> = ({
  count,
  singularLabel = 'seleccionado',
  pluralLabel = 'seleccionados',
  children,
  onClearSelection,
  clearLabel = 'Limpiar selección'
}) => {
  if (count <= 0) return null

  return (
    <div className={styles.tableSelectionToolbar}>
      <span className={styles.tableSelectionCount}>
        {count} {count === 1 ? singularLabel : pluralLabel}
      </span>
      <div className={styles.tableSelectionToolbarActions}>
        {children}
        {onClearSelection && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            iconOnly
            onClick={onClearSelection}
            aria-label={clearLabel}
            title={clearLabel}
            leftIcon={<X size={16} />}
          />
        )}
      </div>
    </div>
  )
}
