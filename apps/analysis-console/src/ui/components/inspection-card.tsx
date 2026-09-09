import type { SecurityInspectionCheck, SecurityInspectionView } from '@xaa/contracts';
import type { Element } from '../element.js';

/**
 * What the analyser did with this agent's logs, whether or not it found anything.
 *
 * The card above this one exists only when something tripped. This one exists whenever
 * logs arrived, and it is the only thing on the screen that can answer the question a
 * person actually opens the console with when nothing is wrong: 「ちゃんと見られている
 * のか」. It shows counts and the names of the passes, and it draws no conclusion from
 * them — there is nothing here to conclude, and inventing a reassurance would be this
 * screen forming an opinion about an agent (RULE-54).
 *
 * `checks_skipped` is not decoration. A pass that could not run is the one case where
 * 「何も出ていない」 must not be read as 「問題がない」, so it is printed beside the
 * passes that did run rather than folded in with them.
 */

const CHECKS: Readonly<Record<SecurityInspectionCheck, string>> = {
  protocol_validation: 'プロトコル違反',
  token_rate: 'トークン要求の回数',
  authorization: '認可の逸脱',
  tool: 'Tool の逸脱',
  lifetime: '有効期限',
  isolation: '分離境界',
  authorization_ai: '権限推論の異常',
  baseline_deviation: '通常の挙動との差',
};

export const INSPECTION_HEADING = '機械的なチェックの記録';
export const INSPECTION_NO_CODES = '反応したルールはありません。';
export const INSPECTION_SKIPPED_LEAD = 'Baseline を読めず、次のチェックは実行できていません';

function Instant(props: { at: string }): Element {
  return <time dateTime={props.at} title={props.at}>{props.at}</time>;
}

function names(checks: readonly string[]): string {
  return checks.map((check) => CHECKS[check as SecurityInspectionCheck] ?? check).join(' / ');
}

export function InspectionCard(props: { inspection: SecurityInspectionView }): Element {
  const inspection = props.inspection;
  return (
    <li className="inspection" data-inspection-id={inspection.inspection_id}>
      <dl className="inspection-facts">
        <dt>見ていた区間</dt>
        <dd data-field="window">
          <Instant at={inspection.window_start} />
          〜
          <Instant at={inspection.window_end} />
        </dd>
        <dt>読んだログ</dt>
        <dd data-field="events_examined">{`${inspection.events_examined} 件`}</dd>
        <dt>通したチェック</dt>
        <dd data-field="checks_run">
          {inspection.checks_run.length === 0 ? '—' : names(inspection.checks_run)}
        </dd>
        <dt>反応したルール</dt>
        <dd data-field="codes_raised">
          {inspection.codes_raised.length === 0 ? INSPECTION_NO_CODES : inspection.codes_raised.join(' / ')}
        </dd>
      </dl>
      {inspection.checks_skipped.length === 0
        ? null
        : (
          <p className="inspection-skipped" data-field="checks_skipped">
            {`${INSPECTION_SKIPPED_LEAD}: ${names(inspection.checks_skipped)}`}
          </p>
        )}
    </li>
  );
}
