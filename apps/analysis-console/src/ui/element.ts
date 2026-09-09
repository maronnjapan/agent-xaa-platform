import type { ReactElement } from 'react';

/**
 * What a component returns, named here so no file has to reach into React's types for
 * the one name it needs.
 *
 * The screens are React components rendered twice from the same source: once on the
 * server, into the HTML a browser is served, and once in the browser, over that same
 * HTML (DEC-APP-06, revised). Naming the return type in one place is what let that
 * change be a change of renderer rather than a change of every file's imports.
 */
export type Element = ReactElement | null;
