'use client';

import { useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';

interface ScenarioFilterProps {
  scenarios: Array<{ scenario: string; count: number }>;
  selectedScenario: string | null;
  onScenarioChange: (scenario: string | null) => void;
  isLoading?: boolean;
}

export function ScenarioFilter({
  scenarios,
  selectedScenario,
  onScenarioChange,
  isLoading = false,
}: ScenarioFilterProps) {
  const [open, setOpen] = useState(false);

  const selectedItem = scenarios.find((s) => s.scenario === selectedScenario);
  // Show the fully-qualified scenario name (e.g. `crowdsecurity/http-bad-user-agent`)
  // rather than just the last path segment, so namespaces aren't ambiguous.
  const displayName = selectedItem ? selectedItem.scenario : 'All scenarios';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'justify-between min-w-[200px]',
            isLoading && 'opacity-50 pointer-events-none'
          )}
          title={displayName}
        >
          <span className="truncate">{displayName}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0">
        <Command>
          <CommandInput placeholder="Search scenario..." />
          <CommandList>
            <CommandEmpty>No scenario found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  onScenarioChange(null);
                  setOpen(false);
                }}
              >
                <Check
                  className={cn('mr-2 h-4 w-4', !selectedScenario ? 'opacity-100' : 'opacity-0')}
                />
                All scenarios
              </CommandItem>
              {scenarios.map((s) => (
                <CommandItem
                  key={s.scenario}
                  value={s.scenario}
                  onSelect={() => {
                    onScenarioChange(s.scenario);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      selectedScenario === s.scenario ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="flex-1 truncate" title={s.scenario}>
                    {s.scenario}
                  </span>
                  <span className="ml-2 text-xs text-slate-400">{s.count}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
