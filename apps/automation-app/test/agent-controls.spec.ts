/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { AgentControls, INSTRUCTION_ADDED, STOP_ACCEPTED } from '../src/ui/components/agent-controls.js';
import { AGENT_ID } from './helpers.js';
import { mount } from './render.js';

/**
 * What the person is told after pressing one of the two buttons on an agent's screen.
 *
 * For the stop, the message is the whole of the feedback. A stop destroys the agent, so
 * the screen has no state left to re-read: the ownership guard answers 404 for an agent
 * that is gone, and the reload every other button ends with would race the cleanup and
 * land the person on a JSON refusal for the agent they had just successfully stopped.
 * The answer is shown in place instead — which is only worth anything if it actually
 * says the stop was taken.
 */
describe('the buttons on an agent screen', () => {
  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  async function press(selector: string, answer: Response, before?: (view: Awaited<ReturnType<typeof mount>>) => void) {
    const asked: Array<{ url: string; method: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      asked.push({ url: String(url), method: String(init.method ?? 'GET') });
      return answer;
    }) as unknown as typeof fetch;
    try {
      const view = await mount(createElement(AgentControls, { agentId: AGENT_ID }));
      before?.(view);
      await view.act(() => { view.find(selector)!.click(); });
      await vi.waitFor(() => { expect(view.text('[data-field="control-status"]')).not.toBe(''); });
      return { view, asked };
    } finally {
      globalThis.fetch = original;
    }
  }

  it('says the stop was taken, and leaves the button pressed', async () => {
    const { view, asked } = await press('[data-action="stop"]', json({ status: 'stopping' }, 200));
    expect(view.text('[data-field="control-status"]')).toBe(STOP_ACCEPTED);
    expect(view.find('[data-field="control-status"]')!.getAttribute('data-status')).toBe('done');
    expect((view.find('[data-action="stop"]') as HTMLButtonElement).disabled).toBe(true);
    expect(asked).toEqual([{ url: `/api/agents/${AGENT_ID}/stop`, method: 'POST' }]);
    await view.unmount();
  });

  it('says a refusal in the words of the refusal, and gives the button back', async () => {
    const { view } = await press('[data-action="stop"]', json({ error: 'not_found' }, 404));
    expect(view.text('[data-field="control-status"]')).toBe('見つかりませんでした。画面を更新してください。');
    expect(view.find('[data-field="control-status"]')!.getAttribute('data-status')).toBe('error');
    expect((view.find('[data-action="stop"]') as HTMLButtonElement).disabled).toBe(false);
    await view.unmount();
  });

  /**
   * An instruction is words, and the box is emptied once they have been taken — so a
   * person who adds a second one is not editing the first by accident.
   */
  it('sends an instruction and clears the box it was written in', async () => {
    const { view, asked } = await press('[data-action="add-instruction"]', json({ status: 'accepted' }, 201), (mounted) => {
      (mounted.find('[name="text"]') as HTMLTextAreaElement).value = '  経費を集計してください  ';
    });
    expect(asked[0]).toEqual({ url: `/api/agents/${AGENT_ID}/instructions`, method: 'POST' });
    expect(view.text('[data-field="control-status"]')).toBe(INSTRUCTION_ADDED);
    expect((view.find('[name="text"]') as HTMLTextAreaElement).value).toBe('');
    await view.unmount();
  });
});
