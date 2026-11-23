'use client';

import { useState } from 'react';
import { Check, ChevronsUpDown, Globe } from 'lucide-react';
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

export interface CountryOption {
  country: string;
  countryName: string | null;
  count: number;
}

interface CountryFilterProps {
  countries: CountryOption[];
  selectedCountry: string | null;
  onCountryChange: (country: string | null) => void;
  isLoading?: boolean;
}

function countryLabel(option: CountryOption): string {
  return option.countryName ? `${option.country} — ${option.countryName}` : option.country;
}

export function CountryFilter({
  countries,
  selectedCountry,
  onCountryChange,
  isLoading = false,
}: CountryFilterProps) {
  const [open, setOpen] = useState(false);

  const selectedItem = countries.find((c) => c.country === selectedCountry);
  // A country from the URL may have no alert in the list: show its code
  const displayName = selectedItem
    ? countryLabel(selectedItem)
    : selectedCountry || 'All countries';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Country"
          className={cn(
            'justify-between min-w-[200px]',
            isLoading && 'opacity-50 pointer-events-none'
          )}
        >
          <Globe className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <span className="truncate">{displayName}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0">
        <Command>
          <CommandInput placeholder="Search country..." />
          <CommandList>
            <CommandEmpty>No country found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  onCountryChange(null);
                  setOpen(false);
                }}
              >
                <Check
                  className={cn('mr-2 h-4 w-4', !selectedCountry ? 'opacity-100' : 'opacity-0')}
                />
                All countries
              </CommandItem>
              {countries.map((c) => (
                <CommandItem
                  key={c.country}
                  value={`${c.country} ${c.countryName ?? ''}`}
                  onSelect={() => {
                    onCountryChange(c.country);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      selectedCountry === c.country ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="flex-1 truncate" title={countryLabel(c)}>
                    {countryLabel(c)}
                  </span>
                  <span className="ml-2 text-xs text-slate-400">{c.count}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
