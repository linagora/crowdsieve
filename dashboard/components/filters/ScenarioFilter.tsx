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
  const displayName = selectedItem ? selectedItem.scenario.split('/').pop() : 'Tous les scénarios';

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
        >
          <span className="truncate">{displayName}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0 z-[500]">
        <Command>
          <CommandInput placeholder="Rechercher un scénario..." />
          <CommandList>
            <CommandEmpty>Aucun scénario trouvé.</CommandEmpty>
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
                Tous les scénarios
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
                    {s.scenario.split('/').pop()}
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
