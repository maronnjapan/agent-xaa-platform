import type { Element } from '../element.js';

export const BLOCKED_GUIDANCE_TEXT = 'この Agent の権限は変更できません。新しい Agent を作成してください。';

/**
 * What a person sees when their agent refused an instruction.
 *
 * There is one link, and it goes to a blank work definition. No "add this permission"
 * button, no query parameter carrying the old agent forward — RULE-13 says an agent's
 * permissions are fixed for its life, so the only honest next step is to describe the
 * work again and let the Authorization Platform decide afresh.
 */
export function BlockedGuidance(): Element {
  return (
    <aside class="blocked-guidance" data-section="blocked-guidance">
      <p>{BLOCKED_GUIDANCE_TEXT}</p>
      <a href="/work-definitions/new" data-action="new-work-definition">新しい作業を定義する</a>
    </aside>
  );
}
