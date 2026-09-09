import type { ActivityRecordHop } from '@xaa/contracts';
import { routeStops } from '../records/verdict.js';
import { labelOf } from '../roles.js';
import type { Element } from '../element.js';

/**
 * The route one step took, as a row of boxes with the exchanges between them.
 *
 * The replay draws the same hops one at a time on the fixed diagram; this lays them
 * all out at once, in order, so the account of a step can be read as a path — the
 * Runtime asked the OP, went to the AS, reached the API and came back — without
 * pressing play. A hop that was refused is drawn as an arrow with a stop on it, in the
 * same colour the diagram uses, so 「止まった」 looks the same wherever it is shown.
 *
 * Every name is the role dictionary's and every label is the hop's own (RULE-54).
 */
export function RouteStrip(props: { hops: readonly ActivityRecordHop[]; compact?: boolean }): Element {
  if (props.hops.length === 0) return null;
  const stops = routeStops(props.hops);
  return (
    <ol className={props.compact ? 'route-strip is-compact' : 'route-strip'} data-route-strip="true" aria-label="やり取りの経路">
      {stops.map((stop, index) => (
        <li key={index} className="route-stop" data-route-node={stop.node} {...(stop.arrival ? { 'data-hop-outcome': stop.arrival.outcome } : {})}>
          {stop.arrival
            ? (
              <span className="route-arrow" data-outcome={stop.arrival.outcome} title={stop.arrival.message}>
                <span className="route-arrow-line" aria-hidden="true" />
                {stop.arrival.outcome === 'blocked' ? <span className="route-stop-mark" aria-hidden="true">×</span> : null}
                {props.compact ? null : <span className="route-arrow-label">{stop.arrival.label}</span>}
                <span className="sr-only">{stop.arrival.label}、{stop.arrival.outcome}</span>
              </span>
            )
            : null}
          <span className="route-node" data-reached={stop.arrival?.outcome === 'blocked' ? 'false' : 'true'}>{labelOf(stop.node)}</span>
        </li>
      ))}
    </ol>
  );
}
