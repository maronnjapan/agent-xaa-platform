/**
 * Just enough DOM to run the replay against.
 *
 * The browser code was previously only reachable through its plan, which is why an
 * arrow that carried no animation went unnoticed. This double supports the handful of
 * calls `replay.ts` makes — attributes, appended children, custom properties and the
 * `[attr]` / `[attr="value"]` selectors — so the DOM the script produces can be
 * asserted without a headless browser in the unit suite.
 */

type AttributeSelector = { name: string; value?: string };

function parseSelector(selector: string): AttributeSelector {
  const match = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (!match) throw new Error(`unsupported selector: ${selector}`);
  return match[2] === undefined ? { name: match[1]! } : { name: match[1]!, value: match[2] };
}

export class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly style = {
    properties: new Map<string, string>(),
    setProperty(name: string, value: string): void { this.properties.set(name, value); },
    getPropertyValue(name: string): string { return this.properties.get(name) ?? ''; },
  };
  textContent = '';

  constructor(readonly tagName: string, readonly ownerDocument: FakeDocument) {}

  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  appendChild(child: FakeElement): FakeElement { this.children.push(child); return child; }

  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }

  querySelectorAll(selector: string): FakeElement[] {
    const wanted = parseSelector(selector);
    return this.descendants().filter((element) => {
      const value = element.attributes.get(wanted.name);
      return value !== undefined && (wanted.value === undefined || value === wanted.value);
    });
  }

  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

export class FakeDocument {
  createElement(tagName: string): FakeElement { return new FakeElement(tagName, this); }
  createElementNS(_namespace: string, tagName: string): FakeElement { return new FakeElement(tagName, this); }
}

export function element(
  document: FakeDocument,
  tagName: string,
  attributes: Record<string, string> = {},
): FakeElement {
  const created = document.createElement(tagName);
  for (const [name, value] of Object.entries(attributes)) created.setAttribute(name, value);
  return created;
}
