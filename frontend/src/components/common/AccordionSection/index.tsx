import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import styles from './AccordionSection.module.css'

interface AccordionSectionProps {
  group: string
  title: string
  children: ReactNode
}

export function AccordionSection({ group, title, children }: AccordionSectionProps) {
  return (
    <details name={group} className={styles.section}>
      <summary className={styles.trigger}>
        <h3 className={styles.heading}>
          {title}
          <ChevronDown size={18} aria-hidden="true" />
        </h3>
      </summary>
      <div className={styles.content}>{children}</div>
    </details>
  )
}
