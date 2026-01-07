'use client';

import * as React from 'react';
import { DayPicker } from 'react-day-picker';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

import 'react-day-picker/style.css';

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      labels={{
        labelMonthDropdown: () => 'Select month',
        labelYearDropdown: () => 'Select year',
        labelNext: () => 'Next month',
        labelPrevious: () => 'Previous month',
        labelDay: (date) => date.toLocaleDateString('en-US'),
        labelWeekday: (date) => date.toLocaleDateString('en-US', { weekday: 'long' }),
        labelWeekNumber: (weekNumber) => `Week ${weekNumber}`,
      }}
      classNames={{
        months: 'flex flex-col sm:flex-row gap-4',
        month: 'space-y-4',
        month_caption: 'flex justify-center pt-1 relative items-center',
        caption_label: 'text-sm font-medium',
        nav: 'space-x-1 flex items-center',
        button_previous: cn(
          'h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100 absolute left-1 inline-flex items-center justify-center rounded-md'
        ),
        button_next: cn(
          'h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100 absolute right-1 inline-flex items-center justify-center rounded-md'
        ),
        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'text-slate-500 rounded-md w-9 font-normal text-[0.8rem] text-center',
        week: 'flex w-full mt-2',
        day: 'h-9 w-9 text-center text-sm p-0 relative focus-within:relative focus-within:z-20',
        day_button: cn(
          'h-9 w-9 p-0 font-normal inline-flex items-center justify-center rounded-full',
          'hover:bg-slate-100 focus:bg-slate-100'
        ),
        selected:
          'bg-crowdsec-primary text-white hover:bg-crowdsec-primary hover:text-white focus:bg-crowdsec-primary focus:text-white rounded-full',
        today: 'bg-slate-100 text-slate-900 rounded-full',
        outside: 'text-slate-400 opacity-50',
        disabled: 'text-slate-400 opacity-50',
        range_middle: 'bg-slate-100 text-slate-900 rounded-none',
        range_start: 'rounded-l-full',
        range_end: 'rounded-r-full',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === 'left' ? (
            <ChevronLeft className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          ),
      }}
      {...props}
    />
  );
}
Calendar.displayName = 'Calendar';

export { Calendar };
