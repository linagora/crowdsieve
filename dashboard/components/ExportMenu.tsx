'use client';

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  downloadExport,
  exportFileName,
  serializeExport,
  type ExportColumn,
  type ExportFormat,
} from '@/lib/export';

interface ExportMenuProps<T> {
  /** CSV columns; the JSON export holds the rows as loaded. */
  columns: readonly ExportColumn<T>[];
  /** File name prefix, e.g. "crowdsieve-alerts". */
  filePrefix: string;
  /**
   * Load the rows to export. `onProgress` may be called with the number of
   * rows loaded so far; `truncated` shows `truncatedNotice` after the download.
   */
  loadRows: (onProgress: (loaded: number) => void) => Promise<{ rows: T[]; truncated: boolean }>;
  truncatedNotice?: string;
  disabled?: boolean;
}

/**
 * "Export" button with a CSV / JSON menu. The file is generated in the
 * browser from the rows `loadRows` returns.
 */
export function ExportMenu<T>({
  columns,
  filePrefix,
  loadRows,
  truncatedNotice,
  disabled = false,
}: ExportMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const exporting = progress !== null;

  const runExport = async (format: ExportFormat) => {
    setOpen(false);
    setError(null);
    setNotice(null);
    setProgress(0);
    try {
      const { rows, truncated } = await loadRows(setProgress);
      downloadExport(
        serializeExport(rows, columns, format),
        exportFileName(filePrefix, format),
        format
      );
      if (truncated && truncatedNotice) setNotice(truncatedNotice);
    } catch (err) {
      setError(`Export failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || exporting}
            className="h-7"
            aria-haspopup="menu"
          >
            {exporting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                Exporting… {progress}
              </>
            ) : (
              <>
                <Download className="h-3.5 w-3.5 mr-1" />
                Export
              </>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-32 p-1" align="start" role="menu">
          {(['csv', 'json'] as const).map((format) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              onClick={() => runExport(format)}
              className="w-full rounded px-3 py-1.5 text-left text-sm hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"
            >
              {format.toUpperCase()}
            </button>
          ))}
        </PopoverContent>
      </Popover>
      {error && (
        <span className="text-xs text-red-600" role="alert">
          {error}
        </span>
      )}
      {notice && <span className="text-xs text-amber-700">{notice}</span>}
    </div>
  );
}
