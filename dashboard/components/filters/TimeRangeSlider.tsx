'use client';

import { useState, useMemo } from 'react';
import { format, subDays, subHours, differenceInDays } from 'date-fns';
import { Calendar as CalendarIcon } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import type { DateRange } from 'react-day-picker';

interface TimeRangeSliderProps {
  minDate: Date;
  maxDate: Date;
  since: Date | null;
  until: Date | null;
  onRangeChange: (since: Date | null, until: Date | null) => void;
  isLoading?: boolean;
}

const PRESETS = [
  { label: '24h', getValue: () => subHours(new Date(), 24) },
  { label: '7d', getValue: () => subDays(new Date(), 7) },
  { label: '30d', getValue: () => subDays(new Date(), 30) },
  { label: 'All', getValue: () => null },
] as const;

export function TimeRangeSlider({
  minDate,
  maxDate,
  since,
  until,
  onRangeChange,
  isLoading = false,
}: TimeRangeSliderProps) {
  const [calendarOpen, setCalendarOpen] = useState(false);

  // Convert dates to slider values (0-100)
  const totalRange = maxDate.getTime() - minDate.getTime();

  const dateToSlider = (date: Date | null, isEnd: boolean): number => {
    if (!date) return isEnd ? 100 : 0;
    const value = ((date.getTime() - minDate.getTime()) / totalRange) * 100;
    return Math.max(0, Math.min(100, value));
  };

  const sliderToDate = (value: number): Date => {
    const time = minDate.getTime() + (value / 100) * totalRange;
    return new Date(time);
  };

  const sliderValues = useMemo(() => {
    return [dateToSlider(since, false), dateToSlider(until, true)];
  }, [since, until, minDate, maxDate]);

  const handleSliderChange = (values: number[]) => {
    const newSince = values[0] > 0 ? sliderToDate(values[0]) : null;
    const newUntil = values[1] < 100 ? sliderToDate(values[1]) : null;
    onRangeChange(newSince, newUntil);
  };

  const handlePresetClick = (getValue: () => Date | null) => {
    const sinceDate = getValue();
    onRangeChange(sinceDate, null);
  };

  const handleCalendarSelect = (range: DateRange | undefined) => {
    if (range) {
      onRangeChange(range.from || null, range.to || null);
    }
    if (range?.from && range?.to) {
      setCalendarOpen(false);
    }
  };

  const formatDateDisplay = (date: Date | null, fallback: string): string => {
    if (!date) return fallback;
    return format(date, 'd MMM yyyy');
  };

  const daysDiff = differenceInDays(until || maxDate, since || minDate);

  return (
    <div className={cn('space-y-3', isLoading && 'opacity-50 pointer-events-none')}>
      {/* Presets and Calendar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1">
          {PRESETS.map((preset) => {
            const presetDate = preset.getValue();
            const isActive =
              preset.label === 'All'
                ? since === null && until === null
                : since?.getTime() === presetDate?.getTime() && until === null;

            return (
              <Button
                key={preset.label}
                variant={isActive ? 'default' : 'secondary'}
                size="sm"
                onClick={() => handlePresetClick(preset.getValue)}
              >
                {preset.label}
              </Button>
            );
          })}
        </div>

        <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <CalendarIcon className="h-4 w-4 mr-2" />
              Calendar
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="end">
            <Calendar
              mode="range"
              selected={{ from: since || undefined, to: until || undefined }}
              onSelect={handleCalendarSelect}
              numberOfMonths={2}
              defaultMonth={since || subDays(new Date(), 30)}
            />
          </PopoverContent>
        </Popover>
      </div>

      {/* Timeline Slider */}
      <div className="px-2">
        <Slider
          value={sliderValues}
          onValueChange={handleSliderChange}
          min={0}
          max={100}
          step={1}
        />
      </div>

      {/* Date labels */}
      <div className="flex justify-between items-center text-sm text-slate-500">
        <span>{formatDateDisplay(minDate, '')}</span>
        <span className="font-medium text-slate-700">
          {formatDateDisplay(since, formatDateDisplay(minDate, 'Start'))}
          {' — '}
          {formatDateDisplay(until, formatDateDisplay(maxDate, 'Now'))}
          {daysDiff > 0 && (
            <span className="text-slate-400 ml-2">
              ({daysDiff} day{daysDiff > 1 ? 's' : ''})
            </span>
          )}
        </span>
        <span>{formatDateDisplay(maxDate, '')}</span>
      </div>
    </div>
  );
}
