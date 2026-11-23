'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface UnbanConfirmationProps {
  /** e.g. "Confirm deletion of 3 decisions". */
  title: string;
  busy: boolean;
  /** Label of the confirm button while busy (default "Deleting..."). */
  busyLabel?: string;
  error?: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

/**
 * Inline confirmation of an unban: a required reason, recorded with the
 * local unban event, and Cancel / Confirm delete buttons.
 */
export function UnbanConfirmation({
  title,
  busy,
  busyLabel = 'Deleting...',
  error,
  onConfirm,
  onCancel,
}: UnbanConfirmationProps) {
  const [reason, setReason] = useState('');
  const trimmedReason = reason.trim();
  const canSubmit = trimmedReason.length > 0 && !busy;

  return (
    <div className="p-3 bg-white border border-slate-300 rounded space-y-2">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      <p className="text-xs text-slate-500">
        A reason is required and will be recorded as a local unban event.
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason for unban (required)..."
        aria-label="Reason for unban"
        maxLength={500}
        rows={2}
        disabled={busy}
        className="w-full px-3 py-2 text-sm border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-crowdsec-primary"
      />
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => canSubmit && onConfirm(trimmedReason)}
          disabled={!canSubmit}
        >
          {busy ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              {busyLabel}
            </>
          ) : (
            'Confirm delete'
          )}
        </Button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
