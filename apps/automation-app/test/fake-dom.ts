/**
 * Just enough DOM to run the replay and the agent screen's two buttons against.
 *
 * The browser code was previously only reachable through its plan, which is why an
 * arrow that carried no animation went unnoticed. This double supports the handful of
 * calls those scripts make — attributes, appended and removed children, custom
 * properties, listeners, and the `[attr]` / `tag[attr="value"]` selectors — so the DOM
 * a script produces can be asserted without a headless browser in the unit suite.
 */

type AttributeSelector = { tagName?: string; name: string; value?: string };

function parseSelector(selector: string): AttributeSelector {
  const match = /^([a-z]+)?\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (!match) throw new Error(`unsupported selector: ${selector}`);
  return {
    ...(match[1] === undefined ? {} : { tagName: match[1] }),
    name: match[2]!,
    ...(match[3] === undefined ? {} : { value: match[3] }),
  };
}

export class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  readonly style = {
    properties: new Map<string, string>(),
    setProperty(name: string, value: string): void { this.properties.set(name, value); },
    getPropertyValue(name: string): string { return this.properties.get(name) ?? ''; },
  };
  textContent = '';
  /** A button the script has pressed and disabled reads back as one here. */
  disabled = false;

  constructor(readonly tagName: string, readonly ownerDocument: FakeDocument) {}

  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  appendChild(child: FakeElement): FakeElement { this.children.push(child); return child; }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const existing = this.listeners.get(type);
    if (existing) existing.push(handler);
    else this.listeners.set(type, [handler]);
  }

  /**
   * Runs this element's own handlers for `type`. There is no bubbling and no default
   * to prevent: the scripts under test wire each control directly, so an event that
   * travelled would only let a test pass for a reason the browser would not.
   */
  dispatch(type: string, event: unknown = { preventDefault(): void {} }): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  /**
   * Removal, because the replay takes the previous step off the canvas before drawing
   * the next one. Without these two the double silently kept every step ever drawn,
   * and a test counting arrows would have passed whatever the browser really did.
   */
  get firstChild(): FakeElement | null { return this.children[0] ?? null; }

  removeChild(child: FakeElement): FakeElement {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    return child;
  }

  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }

  querySelectorAll(selector: string): FakeElement[] {
    const wanted = parseSelector(selector);
    return this.descendants().filter((element) => {
      if (wanted.tagName !== undefined && element.tagName !== wanted.tagName) return false;
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
