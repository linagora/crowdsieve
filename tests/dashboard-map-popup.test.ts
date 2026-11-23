import { describe, it, expect } from 'vitest';
import { buildMapPopup } from '@/lib/mapPopup';

// Minimal DOM fake: textContent is stored as text and escaped on serialization,
// like a real DOM; there is no way to inject markup through it.
class FakeElement {
  children: FakeElement[] = [];
  attrs: Record<string, string> = {};
  text = '';
  constructor(public tag: string) {}
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  appendChild(c: FakeElement) {
    this.children.push(c);
    return c;
  }
  set textContent(v: string) {
    this.text = String(v);
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  get innerHTML(): string {
    const esc = this.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc + this.children.map((c) => c.outerHTML).join('');
  }
  get outerHTML(): string {
    const attrs = Object.entries(this.attrs)
      .map(([k, v]) => ` ${k}="${v.replace(/"/g, '&quot;')}"`)
      .join('');
    return `<${this.tag}${attrs}>${this.innerHTML}</${this.tag}>`;
  }
}
const fakeDoc = { createElement: (t: string) => new FakeElement(t) } as unknown as Document;

describe('buildMapPopup', () => {
  it('renders attacker-controlled fields as literal text', () => {
    const scenario = '<img src=x onerror=alert(1)>';
    const city = '<script>alert(2)</script>';
    const el = buildMapPopup({ scenario, geoCity: city, count: 3 }, fakeDoc);

    expect(el.innerHTML).not.toContain('<img');
    expect(el.innerHTML).not.toContain('<script');
    expect(el.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(el.textContent).toContain(scenario);
    expect(el.textContent).toContain(city);
    expect(el.textContent).toContain('3 alerts');
  });

  it('falls back to country then Unknown and pluralizes', () => {
    const a = buildMapPopup({ scenario: 's', geoCountryName: 'France', count: 1 }, fakeDoc);
    expect(a.textContent).toContain('France');
    expect(a.textContent).toContain('1 alert');
    expect(a.textContent).not.toContain('1 alerts');
    const b = buildMapPopup({ scenario: 's', count: 2 }, fakeDoc);
    expect(b.textContent).toContain('Unknown');
  });
});
