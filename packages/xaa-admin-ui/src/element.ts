import type { ReactElement } from 'react';

/**
 * What a console component returns, named here so no file has to reach into React's
 * types for the one name it needs.
 *
 * The Automation App and the Analysis Console each name this for themselves, because
 * each of them is one app's screens. The admin consoles are several apps' screens built
 * to one description, so the name lives with the description.
 */
export type Element = ReactElement | null;
