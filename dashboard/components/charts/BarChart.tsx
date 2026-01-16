'use client';

const MIN_BAR_HEIGHT_PERCENT = 2;

interface BarChartProps {
  data: Array<{ label: string; value: number }>;
  title: string;
  colorClass?: string;
}

export function BarChart({ data, title, colorClass = 'bg-crowdsec-accent' }: BarChartProps) {
  const maxValue = Math.max(...data.map((d) => d.value), 1);

  return (
    <div className="card p-4">
      <h3 className="text-lg font-semibold mb-4">{title}</h3>
      {data.length > 0 ? (
        <div>
          {/* Bars container */}
          <div className="flex items-end gap-1 h-40 mb-2">
            {data.map((item, index) => (
              <div
                key={index}
                className={`flex-1 ${colorClass} rounded-t transition-all hover:opacity-80 cursor-pointer`}
                style={{
                  height: `${Math.max((item.value / maxValue) * 100, MIN_BAR_HEIGHT_PERCENT)}%`,
                }}
                title={`${item.label}: ${item.value.toLocaleString()}`}
              />
            ))}
          </div>
          {/* Labels */}
          <div className="flex gap-1">
            {data.map((item, index) => (
              <span key={index} className="flex-1 text-xs text-slate-500 text-center truncate">
                {item.label}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="text-center text-slate-400 py-8">No data available</div>
      )}
    </div>
  );
}
