import React, { useMemo } from 'react'
import { Folder, Layers3, SlidersHorizontal } from 'lucide-react'
import { Button } from '../Button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../DropdownMenu'
import styles from './FolderFilterMenu.module.css'

export interface FolderFilterOption {
  id: string
  name: string
  count: number
}

export interface FolderFilterMenuProps {
  value: string
  folders: FolderFilterOption[]
  totalCount: number
  unfiledCount: number
  onChange: (value: string) => void
  allLabel?: string
  unfiledLabel?: string
  ariaLabel?: string
}

export const FolderFilterMenu: React.FC<FolderFilterMenuProps> = ({
  value,
  folders,
  totalCount,
  unfiledCount,
  onChange,
  allLabel = 'Todos los campos',
  unfiledLabel = 'Sin carpeta',
  ariaLabel = 'Abrir filtros'
}) => {
  const selectedLabel = useMemo(() => {
    if (value === 'unfiled') return unfiledLabel
    if (value === 'all') return 'Todos'
    return folders.find(folder => folder.id === value)?.name || 'Todos'
  }, [allLabel, folders, unfiledLabel, value])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={value === 'all' ? 'secondary' : 'primary'}
          size="sm"
          aria-label={ariaLabel}
          leftIcon={<SlidersHorizontal size={16} aria-hidden="true" />}
        >
          {selectedLabel}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className={styles.menu}>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          <DropdownMenuRadioItem value="all" className={styles.option}>
            <span className={styles.optionLabel}>
              <Layers3 size={16} aria-hidden="true" />
              <span>{allLabel}</span>
            </span>
            <span className={styles.optionCount}>{totalCount}</span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="unfiled" className={styles.option}>
            <span className={styles.optionLabel}>
              <Folder size={16} aria-hidden="true" />
              <span>{unfiledLabel}</span>
            </span>
            <span className={styles.optionCount}>{unfiledCount}</span>
          </DropdownMenuRadioItem>
          {folders.map(folder => (
            <DropdownMenuRadioItem key={folder.id} value={folder.id} className={styles.option}>
              <span className={styles.optionLabel}>
                <Folder size={16} aria-hidden="true" />
                <span>{folder.name}</span>
              </span>
              <span className={styles.optionCount}>{folder.count}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
