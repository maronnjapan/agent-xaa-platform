import { REPLAY_NODES } from '@xaa/automation-app/src/ui/replay/nodes';

/**
 * Just enough DOM to play the replay in a Node process.
 *
 * The demo has to be watched, not only planned: `data-blocked` and `data-reached` are
 * set by the browser script, so asserting on the server-rendered HTML would only ever
 * see the page before anything moved. This double supports the calls `replay.ts`
 * makes — attributes, appended children, CSS custom properties, and the `[attr]` /
 * `[attr="value"]` selectors — so the picture a person actually sees can be asserted
 * without a headless browser.
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
    return this.descendants().filter((element_) => {
      const value = element_.attributes.get(wanted.name);
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

function element(document_: FakeDocument, tagName: string, attributes: Record<string, string> = {}): FakeElement {
  const created = document_.createElement(tagName);
  for (const [name, value] of Object.entries(attributes)) created.setAttribute(name, value);
  return created;
}

/** The canvas as the server renders it: every box present, none of them reached yet. */
export function replayCanvas(): FakeElement {
  const document_ = new FakeDocument();
  const root = element(document_, 'div', { class: 'replay', 'data-replay-state': 'idle' });
  const svg = element(document_, 'svg');
  for (const node of REPLAY_NODES) {
    svg.appendChild(element(document_, 'g', {
      'data-node': node.id, 'data-reached': 'false',
      'data-x': String(node.x), 'data-y': String(node.y),
    }));
  }
  svg.appendChild(element(document_, 'g', { 'data-arrows': 'true' }));
  svg.appendChild(element(document_, 'text', { 'data-banner': 'true' }));
  root.appendChild(svg);
  root.appendChild(element(document_, 'ol', { 'data-messages': 'true' }));
  return root;
}
