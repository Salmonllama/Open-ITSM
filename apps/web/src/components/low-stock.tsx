import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { describeLowStock } from '@/lib/consumables';
import { lowStockQuery } from '@/lib/queries';
import { StatusBadge } from './ui/status-badge';

export function LowStockBadge() {
  return <StatusBadge tone="warning">Low stock</StatusBadge>;
}

/** The notice above the asset list while any consumable is at or below its threshold. */
export function LowStockNotice() {
  const low = useQuery(lowStockQuery);
  if (!low.data || low.data.count === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-raised px-4 py-3">
      <LowStockBadge />
      <span className="flex-[1_1_280px]">{describeLowStock(low.data)}</span>
      <Link to="/consumables" search={{ low: true }} className="type-label">
        View consumables
      </Link>
    </div>
  );
}
