import type { HtmlEscapedString } from 'hono/utils/html';

/**
 * What a Hono JSX component returns. Named here so the components do not each reach
 * into hono's internals, and so nothing has to invent a global `JSX` namespace.
 */
export type Element = HtmlEscapedString | Promise<HtmlEscapedString>;
