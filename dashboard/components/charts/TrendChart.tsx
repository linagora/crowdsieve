'use client';

interface TrendChartProps {
  data: Array<{ date: string; count: number }>;
  title: string;
}

export function TrendChart({ data, title }: TrendChartProps) {
  const maxValue = Math.max(...data.map((d) => d.count), 1);

  // Format date for display (show only day/month)
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  };

  return (
    <div className="card p-4">
      <h3 className="text-lg font-semibold mb-4">{title}</h3>
      {data.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-end gap-px h-32">
            {data.map((item, index) => (
              <div
                key={index}
                className="flex-1 bg-blue-500 rounded-t min-w-[2px] hover:bg-blue-400 transition-colors"
                style={{ height: `${(item.count / maxValue) * 100}%` }}
                title={`${formatDate(item.date)}: ${item.count.toLocaleString()} alerts`}
              />
            ))}
          </div>
          <div className="flex justify-between text-xs text-slate-500">
            <span>{data.length > 0 ? formatDate(data[0].date) : ''}</span>
            <span>{data.length > 0 ? formatDate(data[data.length - 1].date) : ''}</span>
          </div>
        </div>
      ) : (
        <div className="text-center text-slate-400 py-8">No data available</div>
      )}
    </div>
  );
}
