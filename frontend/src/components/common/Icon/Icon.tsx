export {
  // Navigation
  LayoutDashboard as DashboardIcon,
  BarChart3 as ReportsIcon,
  Megaphone as CampaignsIcon,
  Receipt as TransactionsIcon,
  Users as ContactsIcon,
  Settings as SettingsIcon,

  // Common UI
  Menu as MenuIcon,
  X as CloseIcon,
  Search as SearchIcon,
  Filter as FilterIcon,
  Download as DownloadIcon,
  Plus as PlusIcon,
  Edit as EditIcon,
  Trash2 as TrashIcon,
  Info as InfoIcon,
  AlertCircle as AlertIcon,
  Calendar as CalendarIcon,
  Clock as ClockIcon,
  RefreshCw as RefreshIcon,

  // Directions
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  ArrowLeft,
  ArrowRight,

  // Status
  CheckCircle,
  Check,
  XCircle,

  // Business
  DollarSign,
  CreditCard,
  Banknote,
  TrendingUp,
  TrendingDown,
  Target,
  User,
  Users,
  Receipt,
  RotateCcw,
  Wallet,

  // Theme
  Sun,
  Moon,

  // Files
  FileText as DocIcon,

  // Integrations
  MessageSquare,
  Facebook,
  Instagram,
  MessageCircle
} from 'lucide-react'

// Legacy Icon component for backward compatibility
import React from 'react'
import * as LucideIcons from 'lucide-react'
import { MetaIcon, WhatsAppIcon, GoogleIcon } from './CustomIcons'

interface IconProps {
  name: string
  size?: number
  className?: string
  color?: string
}

// Map old icon names to Lucide components
const iconMap: Record<string, React.FC<any>> = {
  'dashboard': LucideIcons.LayoutDashboard,
  'reports': LucideIcons.BarChart3,
  'campaigns': LucideIcons.Megaphone,
  'transactions': LucideIcons.Receipt,
  'contacts': LucideIcons.Users,
  'settings': LucideIcons.Settings,
  'money': LucideIcons.DollarSign,
  'chart': LucideIcons.TrendingUp,
  'target': LucideIcons.Target,
  'trending-up': LucideIcons.TrendingUp,
  'trending-down': LucideIcons.TrendingDown,
  'users': LucideIcons.Users,
  'user': LucideIcons.User,
  'user-plus': LucideIcons.UserPlus,
  'receipt': LucideIcons.Receipt,
  'refresh': LucideIcons.RefreshCw,
  'sun': LucideIcons.Sun,
  'moon': LucideIcons.Moon,
  'menu': LucideIcons.Menu,
  'close': LucideIcons.X,
  'chevron-down': LucideIcons.ChevronDown,
  'chevron-up': LucideIcons.ChevronUp,
  'chevron-left': LucideIcons.ChevronLeft,
  'chevron-right': LucideIcons.ChevronRight,
  'search': LucideIcons.Search,
  'filter': LucideIcons.Filter,
  'download': LucideIcons.Download,
  'plus': LucideIcons.Plus,
  'edit': LucideIcons.Edit,
  'trash': LucideIcons.Trash2,
  'check': LucideIcons.Check,
  'x': LucideIcons.X,
  'info': LucideIcons.Info,
  'alert': LucideIcons.AlertCircle,
  'calendar': LucideIcons.Calendar,
  'clock': LucideIcons.Clock,
  'megaphone': LucideIcons.Megaphone,
  'return': LucideIcons.RotateCcw,
  'doc': LucideIcons.FileText,
  'dollar': LucideIcons.DollarSign,
  'circle-dollar-sign': LucideIcons.CircleDollarSign,
  'mouse-pointer-click': LucideIcons.MousePointerClick,
  'facebook': LucideIcons.Facebook,
  'meta': MetaIcon as any,
  'whatsapp': WhatsAppIcon as any,
  'google': GoogleIcon as any,
  'message-circle': LucideIcons.MessageCircle
}

export const Icon: React.FC<IconProps> = ({ name, size = 24, className = '', color = 'currentColor' }) => {
  const IconComponent = iconMap[name]

  if (!IconComponent) {
    // TODO: Implement proper logging service
    return null
  }

  return <IconComponent size={size} className={className} color={color} />
}