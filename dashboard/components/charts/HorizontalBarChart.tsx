'use client';

interface HorizontalBarChartProps {
  data: Array<{ label: string; value: number; flag?: string }>;
  title: string;
  maxBars?: number;
}

export function HorizontalBarChart({ data, title, maxBars = 10 }: HorizontalBarChartProps) {
  const displayData = data.slice(0, maxBars);
  const maxValue = Math.max(...displayData.map((d) => d.value), 1);

  return (
    <div className="card p-4">
      <h3 className="text-lg font-semibold mb-4">{title}</h3>
      {displayData.length > 0 ? (
        <div className="space-y-3">
          {displayData.map((item, index) => (
            <div key={index}>
              <div className="flex justify-between text-sm mb-1">
                <span className="text-slate-700 flex items-center gap-2 truncate">
                  {item.flag && <span>{item.flag}</span>}
                  <span className="truncate">{item.label}</span>
                </span>
                <span className="text-slate-500 ml-2 shrink-0">
                  {item.value.toLocaleString()}
                </span>
              </div>
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-crowdsec-primary to-crowdsec-accent rounded-full transition-all duration-300"
                  style={{ width: `${(item.value / maxValue) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center text-slate-400 py-8">No data available</div>
      )}
    </div>
  );
}
