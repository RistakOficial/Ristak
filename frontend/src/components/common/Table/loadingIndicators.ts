interface TableLoadingIndicatorOptions {
  isRefreshing: boolean
  hasSearchControl: boolean
  hasSearchTerm: boolean
}

interface TableLoadingIndicators {
  search: boolean
  standalone: boolean
}

export const getTableLoadingIndicators = ({
  isRefreshing,
  hasSearchControl,
  hasSearchTerm
}: TableLoadingIndicatorOptions): TableLoadingIndicators => {
  const search = isRefreshing && hasSearchControl && hasSearchTerm

  return {
    search,
    standalone: isRefreshing && !search
  }
}
