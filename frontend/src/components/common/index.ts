// Componentes básicos
export { Button } from './Button'
export { Card } from './Card'
export { Modal } from './Modal'
export { TabList } from './TabList'
export { Logo } from './Logo'
export { RistakAppMark } from './RistakAppMark'
export { PageContainer } from './PageContainer'
export { PageHeader } from './PageHeader'

// Componentes de datos
export { KpiCard } from './KpiCard'
export { AreaChart } from './AreaChart'
export { BarChart } from './BarChart'
export type { BarChartData } from './BarChart'
export { Table } from './Table'
export { TableSelectionToolbar } from './Table'
export type { Column } from './Table'
export { TrafficSourcesChart } from './TrafficSourcesChart'
export { OriginDistributionCard } from './OriginDistributionCard'
export { ConversionFunnelChart } from './ConversionFunnelChart'

// Componentes de fecha
export { DateRangePicker } from './DateRangePicker'

// Componentes de filtros
export { TreeFilter } from './TreeFilter'

// Componentes de contacto
export { ContactDetailsModal } from './ContactDetailsModal'
export { ContactCustomFieldsPanel } from './ContactCustomFieldsPanel'
export type { ContactCustomFieldsPanelProps } from './ContactCustomFieldsPanel'
export { ContactAvatar } from './ContactAvatar'
export { ContactPhoneSelector } from './ContactPhoneSelector'
export { ContactSearchInput } from './ContactSearchInput/ContactSearchInput'
export { VisitorDetailsModal } from './VisitorDetailsModal'

// Componentes de pagos
export { RecordPaymentModal } from './RecordPaymentModal'
export { TransactionsModal } from './TransactionsModal'
export { PaymentLinkReadyPanel } from './PaymentLinkReadyPanel'
export type { PaymentLinkReadyData, PaymentLinkReadyKind, PaymentLinkReadyContact } from './PaymentLinkReadyPanel'

// Componentes de citas
export { AppointmentModal } from './AppointmentModal'
export { BlockedSlotModal } from './BlockedSlotModal'

// Componentes de UI
export { ViewSelector } from './ViewSelector'
export { HelpTooltip } from './HelpTooltip'
export { Icon } from './Icon'
export { InlineEditableText } from './InlineEditableText'
export type { InlineEditableTextProps } from './InlineEditableText'
export { SearchField } from './SearchField'
export type { SearchFieldProps } from './SearchField'
export { PathInput } from './PathInput'
export type { PathInputProps } from './PathInput'
export { Badge } from './Badge'
export type { BadgeVariant } from './Badge'
export { ChatMessageSurface } from './ChatMessageSurface'
export type { ChatMessageSurfaceProps } from './ChatMessageSurface'
export {
  EmailChatMessageBubble,
  buildEmailChatMessageData,
  hasEmailChatMessageContent,
  type EmailChatMessageData
} from './EmailChatMessageBubble/EmailChatMessageBubble'
export {
  WhatsAppFormattedInlineText,
  WhatsAppFormattedText
} from './WhatsAppFormattedText'
export type {
  WhatsAppFormattedInlineTextProps,
  WhatsAppFormattedTextProps
} from './WhatsAppFormattedText'
export { CustomSelect } from './CustomSelect'
export { MetaBrandMark } from './MetaBrandMark'
export type { MetaBrandMarkProps } from './MetaBrandMark'
export { MetaParameterValueInput }
  from './MetaParameterValueInput/MetaParameterValueInput'
export type { MetaParameterVariable }
  from './MetaParameterValueInput/MetaParameterValueInput'
export { TagPicker, useContactTags } from './TagPicker'
export { NumberInput } from './NumberInput'
export type { NumberInputProps } from './NumberInput'
export { Switch } from './Switch'
export { SegmentTabs } from './SegmentTabs'
export type { SegmentTab } from './SegmentTabs'
export {
  PaymentGateControls,
  normalizePaymentGateConfig,
  type PaymentGateConfig,
  type PaymentGateGateway
} from './PaymentGateControls'
export { PaymentPlatformLogo, getPaymentPlatformLabel } from './PaymentPlatformLogo'
export type { PaymentPlatformLogoId } from './PaymentPlatformLogo'
export { Loading } from './Loading'
export { AppStartupLoader } from './AppStartupLoader'
export { MediaUploadTray } from './MediaUploadTray'
export type { MediaUploadTask, MediaUploadTaskStatus } from './MediaUploadTray'
export {
  EmailRichTextEditor,
  emailHtmlToPlainText,
  plainTextToEmailHtml,
  sanitizeEmailRichHtmlForEditor,
  type EmailRichTextVariable
} from './EmailRichTextEditor'
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from './DropdownMenu'

// Componentes de tracking
export { SessionsTable } from './SessionsTable/SessionsTable'
