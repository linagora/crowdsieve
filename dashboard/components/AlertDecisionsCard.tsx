import Link from 'next/link';
import type { AlertDetailDecision } from '@/lib/types';
import { isDecisionExpired, type ManualBanDecision } from '@/lib/alertDetail';
import { LocalDateTime } from '@/components/LocalDateTime';

interface AlertDecisionsCardProps {
  decisions: Array<AlertDetailDecision | ManualBanDecision>;
  /** Current time (ms), to flag expired decisions. */
  now: number;
}

/**
 * Decisions CrowdSec took for an alert. Every value comes from stored alert
 * data and is rendered as text only.
 */
export function AlertDecisionsCard({ decisions, now }: AlertDecisionsCardProps) {
  return (
    <div className="card p-6">
      <h2 className="text-lg font-semibold mb-4">Decisions</h2>
      {decisions.length === 0 ? (
        <p className="text-slate-500 text-sm">No decision was taken for this alert</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-600 border-b border-slate-200">
                <th className="py-2 pr-4 font-medium">Type</th>
                <th className="py-2 pr-4 font-medium">Value</th>
                <th className="py-2 pr-4 font-medium">Duration</th>
                <th className="py-2 pr-4 font-medium">Expires</th>
                <th className="py-2 pr-4 font-medium">Origin</th>
                <th className="py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((decision, index) => {
                const expired = isDecisionExpired(decision.until, now);
                const server = 'server' in decision ? decision.server : null;
                return (
                  <tr key={`${decision.id}-${index}`} className="border-b border-slate-100">
                    <td className="py-2 pr-4">
                      <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded text-xs font-medium">
                        {decision.type}
                      </span>
                      {decision.simulated && (
                        <span className="ml-1 px-2 py-0.5 bg-blue-100 text-blue-800 rounded text-xs">
                          simulated
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4 font-mono break-all">
                      {decision.scope}: {decision.value}
                    </td>
                    <td className="py-2 pr-4">{decision.duration || 'N/A'}</td>
                    <td className="py-2 pr-4">
                      {decision.until ? (
                        expired ? (
                          <span className="text-slate-400" title={decision.until}>
                            expired
                          </span>
                        ) : (
                          <LocalDateTime value={decision.until} />
                        )
                      ) : (
                        'N/A'
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {decision.origin || 'N/A'}
                      {server && <span className="text-slate-500"> · {server}</span>}
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <Link
                        href={`/decisions?ip=${encodeURIComponent(decision.value)}`}
                        className="text-crowdsec-primary hover:underline"
                      >
                        Check live status
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
