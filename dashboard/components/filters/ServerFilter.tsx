'use client';

import { useState } from 'react';
import { Check, ChevronsUpDown, Server } from 'lucide-react';
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

interface ServerFilterProps {
  machines: Array<{ machineId: string; count: number }>;
  selectedMachineId: string | null;
  onMachineChange: (machineId: string | null) => void;
  isLoading?: boolean;
}

export function ServerFilter({
  machines,
  selectedMachineId,
  onMachineChange,
  isLoading = false,
}: ServerFilterProps) {
  const [open, setOpen] = useState(false);

  const selectedItem = machines.find((m) => m.machineId === selectedMachineId);
  const displayName = selectedItem ? selectedItem.machineId : 'All servers';

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
          <Server className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <span className="truncate">{displayName}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0 z-[500]">
        <Command>
          <CommandInput placeholder="Search server..." />
          <CommandList>
            <CommandEmpty>No server found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  onMachineChange(null);
                  setOpen(false);
                }}
              >
                <Check
                  className={cn('mr-2 h-4 w-4', !selectedMachineId ? 'opacity-100' : 'opacity-0')}
                />
                All servers
              </CommandItem>
              {machines.map((m) => (
                <CommandItem
                  key={m.machineId}
                  value={m.machineId}
                  onSelect={() => {
                    onMachineChange(m.machineId);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      selectedMachineId === m.machineId ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="flex-1 truncate" title={m.machineId}>
                    {m.machineId}
                  </span>
                  <span className="ml-2 text-xs text-slate-400">{m.count}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
