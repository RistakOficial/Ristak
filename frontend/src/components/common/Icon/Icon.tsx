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
  'arrow-right': LucideIcons.ArrowRight,
  'arrow-left': LucideIcons.ArrowLeft,
  'file-text': LucideIcons.FileText,
  'hash': LucideIcons.Hash,
  'layers': LucideIcons.Layers,
  'link': LucideIcons.Link,
  'link-2': LucideIcons.Link2,
  'loader-2': LucideIcons.Loader2,
  'mail': LucideIcons.Mail,
  'map-pin': LucideIcons.MapPin,
  'monitor': LucideIcons.Monitor,
  'phone': LucideIcons.Phone,
  'share-2': LucideIcons.Share2,
  'smartphone': LucideIcons.Smartphone,
  'tag': LucideIcons.Tag,
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
  'calendar-check': LucideIcons.CalendarCheck,
  'clock': LucideIcons.Clock,
  'megaphone': LucideIcons.Megaphone,
  'return': LucideIcons.RotateCcw,
  'doc': LucideIcons.FileText,
  'dollar': LucideIcons.DollarSign,
  'dollar-sign': LucideIcons.DollarSign,
  'circle-dollar-sign': LucideIcons.CircleDollarSign,
  'mouse-pointer-click': LucideIcons.MousePointerClick,
  'sparkles': LucideIcons.Sparkles,
  'globe': LucideIcons.Globe,
  'message-square': LucideIcons.MessageSquare,
  'facebook': LucideIcons.Facebook,
  'instagram': LucideIcons.Instagram,
  'tiktok': LucideIcons.Music2,
  'youtube': LucideIcons.Youtube,
  'linkedin': LucideIcons.Linkedin,
  'twitter': LucideIcons.Twitter,
  'bing': LucideIcons.Search,
  'telegram': LucideIcons.Send,
  'pinterest': LucideIcons.Pin,
  'reddit': LucideIcons.MessageCircle,
  'email': LucideIcons.Mail,
  'meta': MetaIcon as any,
  'meta-ads': MetaIcon as any,
  'whatsapp': WhatsAppIcon as any,
  'google': GoogleIcon as any,
  'message-circle': LucideIcons.MessageCircle,
  'circle': LucideIcons.Circle
}

export const Icon: React.FC<IconProps> = ({ name, size = 24, className = '', color = 'currentColor' }) => {
  const IconComponent = iconMap[name]

  if (!IconComponent) {
    // TODO: Implement proper logging service
    return null
  }

  return <IconComponent size={size} className={className} color={color} />
}
