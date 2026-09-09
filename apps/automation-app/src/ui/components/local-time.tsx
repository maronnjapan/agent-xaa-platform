import { useEffect, useState } from 'react';
import type { Element } from '../element.js';

/** How much of the instant to print. The recorded value is always in the tooltip. */
export type LocalTimeFormat = 'full' | 'short' | 'time';

const FORMATS: Readonly<Record<LocalTimeFormat, Intl.DateTimeFormatOptions>> = {
  full: { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false },
  short: { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false },
  time: { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false },
};

/**
 * The recorded instant, shown in the reader's own clock.
 *
 * The page is served with the instant as it was recorded, in UTC, which is what the
 * record is — and what a reader with no script still sees. A person in Tokyo reading
 * `09:00Z` beside something they did at six in the evening concludes the order is
 * wrong, so once the browser has the page it re-sets the text to the same instant in
 * the browser's zone. The `dateTime` attribute keeps the recorded value and the
 * original stays as the tooltip. Nothing about the order changes.
 *
 * The switch happens in an effect rather than during render, because the server and
 * the browser must produce the same markup for hydration to attach to it — and the
 * server has no idea what zone the reader is in.
 *
 * `short` and `time` drop the parts a row does not need: a list of steps that all
 * happened on one afternoon reads better as `14:03:21` than as ten copies of the date.
 * The full instant is one hover away either way.
 */
export function LocalTime(props: { at: string; className?: string; format?: LocalTimeFormat }): Element {
  const [shown, setShown] = useState(props.at);
  const format = props.format ?? 'full';
  useEffect(() => {
    const millis = Date.parse(props.at);
    if (!Number.isFinite(millis)) return;
    try {
      setShown(new Intl.DateTimeFormat('ja-JP', FORMATS[format]).format(new Date(millis)));
    } catch {
      // A browser without Intl keeps the recorded text, which is still correct.
    }
  }, [props.at, format]);
  return <time className={props.className} dateTime={props.at} title={props.at}>{shown}</time>;
}
