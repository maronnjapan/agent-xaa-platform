import { ACTOR_ROLES, LANE_LABELS, rolesFor, type ActorRole } from '../roles.js';
import type { Element } from '../element.js';

export const CAST_CAPTION = 'この記録に出てくるもの';
export const CAST_NOTE = '名前だけでは何をするところか分からないので、役割を並べておきます。どの箱も、できることとできないことが決まっています。「しないこと」の側が、この仕組みの要点です。';
export const CAST_DOES = 'すること';
export const CAST_DOES_NOT = 'しないこと';

/**
 * Who is who, on the screen where their names appear.
 *
 * The timeline names ten different parts and assumes the reader knows all of them.
 * They do not — 「それぞれのアプリって何をしているか全然わからない」 — and a person who
 * cannot tell the Resource AS from the Resource API cannot see what the picture is
 * claiming when an arrow stops between them.
 *
 * Each card carries what the part does and what it deliberately does not, because the
 * second half is the one that explains the shape of the platform: the thing that
 * decides is not the thing that acts, and the thing that watches does not stop
 * anything. These are fixed descriptions of the platform's own parts, the same on
 * every task — screen furniture, not an opinion about an event (RULE-54).
 *
 * It lists the parts that appear in the records being shown, not all ten, so a person
 * reading one tool call is not handed a directory of a platform they did not use.
 */
export function CastPanel(props: { sources?: Iterable<string>; open?: boolean }): Element {
  const actors = props.sources === undefined ? ACTOR_ROLES : rolesFor(props.sources);
  if (actors.length === 0) return null;
  return (
    <details className="cast" data-section="cast" {...(props.open ? { open: true } : {})}>
      <summary>{CAST_CAPTION}</summary>
      <p className="cast-note">{CAST_NOTE}</p>
      <ul className="cast-list">
        {actors.map((actor) => <li key={actor.id}><RoleCard actor={actor} /></li>)}
      </ul>
    </details>
  );
}

/**
 * One part, in four lines: what it is called, what it is for, what it does, and what it
 * does not do.
 *
 * The same card is what a box on the diagram opens, so a person who clicks a box while
 * a replay is paused reads exactly what the list beside the picture would have told
 * them.
 */
export function RoleCard(props: { actor: ActorRole }): Element {
  const actor = props.actor;
  return (
    <article className="role-card" data-role-id={actor.id} data-role-lane={actor.lane}>
      <p className="role-card-head">
        <span className="role-card-label">{actor.label}</span>
        <span className="role-card-lane">{LANE_LABELS[actor.lane]}</span>
      </p>
      <p className="role-card-role">{actor.role}</p>
      <dl className="role-card-body">
        <dt>{CAST_DOES}</dt>
        <dd data-field="role-does">{actor.does}</dd>
        <dt>{CAST_DOES_NOT}</dt>
        <dd data-field="role-does-not">{actor.doesNot}</dd>
      </dl>
    </article>
  );
}
