import * as React from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Check } from 'lucide-react'
import { getFloatingLayerZIndex } from '@/utils/layering'
import styles from './DropdownMenu.module.css'

interface DropdownMenuLayerContextValue {
  layerZIndex: string
  captureTrigger: (node: HTMLElement | null) => void
}

const DropdownMenuLayerContext = React.createContext<DropdownMenuLayerContextValue | null>(null)

const assignRef = <T,>(ref: React.ForwardedRef<T> | undefined, value: T | null) => {
  if (typeof ref === 'function') ref(value)
  else if (ref) ref.current = value
}

const DropdownMenu: React.FC<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Root>> = (props) => {
  const [layerZIndex, setLayerZIndex] = React.useState('var(--z-index-popover)')
  const captureTrigger = React.useCallback((node: HTMLElement | null) => {
    if (!node) return
    const nextZIndex = getFloatingLayerZIndex(node, 'popover')
    setLayerZIndex(current => current === nextZIndex ? current : nextZIndex)
  }, [])
  const layerContext = React.useMemo(() => ({ layerZIndex, captureTrigger }), [captureTrigger, layerZIndex])
  return (
    <DropdownMenuLayerContext.Provider value={layerContext}>
      <DropdownMenuPrimitive.Root {...props} />
    </DropdownMenuLayerContext.Provider>
  )
}

const DropdownMenuTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>
>((props, forwardedRef) => {
  const layerContext = React.useContext(DropdownMenuLayerContext)
  return (
    <DropdownMenuPrimitive.Trigger
      ref={(node) => {
        layerContext?.captureTrigger(node)
        assignRef(forwardedRef, node)
      }}
      {...props}
    />
  )
})
DropdownMenuTrigger.displayName = DropdownMenuPrimitive.Trigger.displayName

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, style, onEscapeKeyDown, ...props }, ref) => {
  const layerContext = React.useContext(DropdownMenuLayerContext)
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={`${styles.content} ${className || ''}`}
        data-ristak-dropdown-panel
        style={{
          ...style,
          zIndex: layerContext?.layerZIndex || 'var(--z-index-popover)'
        }}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event)
          event.stopPropagation()
        }}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
})
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean
    unstyled?: boolean
  }
>(({ className, inset, unstyled = false, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={unstyled
      ? className
      : `${styles.item} ${inset ? styles.inset : ''} ${className || ''}`}
    data-ristak-dropdown-item={unstyled ? undefined : ''}
    data-ristak-unstyled={unstyled ? '' : undefined}
    {...props}
  />
))
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    className={`${styles.item} ${styles.checkboxItem} ${className || ''}`}
    data-ristak-dropdown-item
    {...props}
  >
    <DropdownMenuPrimitive.ItemIndicator className={styles.itemIndicator}>
      <Check size={15} aria-hidden="true" />
    </DropdownMenuPrimitive.ItemIndicator>
    <span>{children}</span>
  </DropdownMenuPrimitive.CheckboxItem>
))
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName

const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    className={`${styles.item} ${styles.radioItem} ${className || ''}`}
    data-ristak-dropdown-item
    {...props}
  >
    {children}
  </DropdownMenuPrimitive.RadioItem>
))
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={`${styles.separator} ${className || ''}`}
    {...props}
  />
))
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
}
