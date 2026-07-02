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
        {React.Children.map(children, (child) => {
          if (child === null || child === undefined || typeof child === 'boolean') return null
          return (
            <span className={styles.tableSelectionToolbarActionItem}>
              {child}
            </span>
          )
        })}
        {onClearSelection && (
          <span className={styles.tableSelectionToolbarActionItem}>
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
          </span>
        )}
      </div>
    </div>
  )
}
