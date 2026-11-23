export interface MapPopupData {
  geoCity?: string | null;
  geoCountryName?: string | null;
  scenario: string;
  count: number;
}

/**
 * Build the map marker popup from DOM nodes. Alert fields are attacker
 * controlled, so they are only ever assigned through textContent (never HTML).
 */
export function buildMapPopup(data: MapPopupData, doc: Document = document): HTMLElement {
  const make = (style: string, text: string): HTMLElement => {
    const el = doc.createElement('div');
    el.setAttribute('style', style);
    el.textContent = text;
    return el;
  };

  const root = doc.createElement('div');
  root.setAttribute('style', 'padding: 8px;');
  root.appendChild(make('font-weight: bold;', data.geoCity || data.geoCountryName || 'Unknown'));
  root.appendChild(
    make('font-size: 12px; color: #666;', `${data.count} alert${data.count > 1 ? 's' : ''}`)
  );
  root.appendChild(make('font-size: 11px; margin-top: 4px;', `Latest: ${data.scenario}`));
  return root;
}
