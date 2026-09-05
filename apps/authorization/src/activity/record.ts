import {
  redactRecordText,
  type ActivityRecord, type ActivityRecordCheck, type ActivityRecordField, type ActivityRecordSection,
  type CapabilityDecision, type Characteristics, type SecurityProfile,
} from '@xaa/contracts';
import type { Warning } from '../ai/output-guard.js';
import { REASON_MESSAGES } from './messages.js';

/**
 * What the Authorization Platform writes about one decision, for the person it was
 * made for (docs 11 §3.4).
 *
 * A decision used to reach the timeline as one line — 許可：a／却下：b（理由：c）— and
 * nothing else. A person reading it could not tell what the model had understood the
 * work to be, what it had proposed and on what grounds, which of the five filters had
 * removed what, or why the isolation level came out as it did. This record answers
 * those in order: what the AI read, what it proposed and said, what the Policy Engine
 * did with each proposal, what conditions were attached, and how the profile was set.
 *
 * Everything with words in it is written here, at the moment of the decision, by the
 * component that holds the reasons (RULE-55). The screen lays it out and composes
 * nothing (RULE-54). The AI's own words are carried as prose and marked as the AI's:
 * they are a proposal's stated grounds, never the decision (RULE-10).
 */

export interface DecisionRecordInput {
  decisionId: string;
  status: 'decided' | 'no_capability_inferred';
  purpose: string;
  description: string;
  workDefinition: {
    operations: readonly string[];
    targetResources: readonly string[];
    droppedOperations: readonly string[];
    droppedTargetResources: readonly string[];
    note?: string | undefined;
  };
  proposal: {
    capabilities: readonly string[];
    characteristics: Partial<Characteristics>;
    confidence: number;
    note?: string | undefined;
    droppedOutOfTaxonomy: readonly string[];
  };
  warnings: readonly Warning[];
  humanPermissions: readonly string[];
  characteristics?: Characteristics | undefined;
  decisions: readonly CapabilityDecision[];
  effective: readonly string[];
  constraints: Record<string, Record<string, unknown>>;
  securityProfile: SecurityProfile;
}

function joined(values: readonly string[]): string {
  return values.length === 0 ? '—' : values.map((value) => redactRecordText(value)).join('、');
}

function pairs(values: object): string {
  const entries = Object.entries(values as Record<string, unknown>);
  return entries.length === 0 ? '—' : entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('、');
}

function prose(text: string | undefined): { text: string; format: 'text' } | Record<string, never> {
  return text && text.trim() !== '' ? { text: redactRecordText(text), format: 'text' } : {};
}

/**
 * One check per capability the AI proposed, in the AI's own order.
 *
 * The answer to "why did I get these and not those" is per capability, and it is a
 * verdict with a reason — which is what a check is. A proposal that named something
 * outside the taxonomy is a check too: it was refused before any policy saw it, and
 * saying so is different from saying a policy refused it.
 */
function capabilityChecks(input: DecisionRecordInput): ActivityRecordCheck[] {
  const dropped = new Set(input.proposal.droppedOutOfTaxonomy);
  const byCapability = new Map(input.decisions.map((decision) => [decision.capability_id, decision]));
  const checks: ActivityRecordCheck[] = [];
  for (const capability of [...new Set(input.proposal.capabilities)]) {
    const id = `capability:${capability}`;
    if (dropped.has(capability)) {
      checks.push({ id, label: capability, result: 'blocked', message: 'Capability 一覧に無い名前のため、判断の対象から外しました。' });
      continue;
    }
    const decision = byCapability.get(capability);
    if (!decision) {
      checks.push({ id, label: capability, result: 'skipped', message: 'Policy Engine まで届きませんでした。' });
      continue;
    }
    if (decision.decision === 'ALLOW') {
      checks.push({ id, label: capability, result: 'passed', message: REASON_MESSAGES.allowed });
      continue;
    }
    const policy = decision.policy_id ? `（ポリシー ${decision.policy_id}）` : '';
    checks.push({ id, label: capability, result: 'blocked', message: `${REASON_MESSAGES[decision.reason_code]}${policy}` });
  }
  return checks;
}

function workDefinitionSection(input: DecisionRecordInput): ActivityRecordSection {
  return {
    id: 'work_definition',
    label: 'Authorization AI が読み取った作業',
    message: '送られてきた業務の言葉から、想定される操作と対象を取り出しました。一覧に無い対象は取り上げていません。',
    fields: [
      { label: '目的', value: redactRecordText(input.purpose) },
      { label: '内容', value: redactRecordText(input.description) },
      { label: '想定される操作', value: joined(input.workDefinition.operations) },
      { label: '対象リソース', value: joined(input.workDefinition.targetResources) },
      { label: '取り上げなかった対象', value: joined(input.workDefinition.droppedTargetResources) },
      { label: '取り上げなかった操作', value: joined(input.workDefinition.droppedOperations) },
    ],
    ...prose(input.workDefinition.note),
  };
}

function proposalSection(input: DecisionRecordInput): ActivityRecordSection {
  const stated = Object.entries(input.proposal.characteristics)
    .filter(([, value]) => typeof value === 'boolean')
    .map(([key, value]) => `${key}=${String(value)}`);
  const removed = input.warnings.map((warning) => `${warning.field}（${warning.code}）`);
  return {
    id: 'proposal',
    label: 'Authorization AI の提案',
    message: 'AI が必要だと考えた Capability です。これは提案であり、決定ではありません。決定は下の Policy Engine が行います。',
    fields: [
      { label: '提案した Capability', value: joined(input.proposal.capabilities) },
      { label: '確信度', value: String(input.proposal.confidence) },
      { label: 'AI が述べた性質', value: joined(stated) },
      { label: '一覧に無かった提案', value: joined(input.proposal.droppedOutOfTaxonomy) },
      { label: '受け取らなかった項目', value: joined(removed) },
    ],
    ...prose(input.proposal.note),
  };
}

function policySection(input: DecisionRecordInput): ActivityRecordSection {
  const fields: ActivityRecordField[] = [
    { label: '本人が持っている権限', value: joined(input.humanPermissions) },
    { label: '判断に使った性質', value: input.characteristics ? pairs(input.characteristics) : '—' },
  ];
  for (const decision of input.decisions) {
    const policy = decision.policy_id ? `（ポリシー ${decision.policy_id}）` : '';
    fields.push({
      label: decision.capability_id,
      value: decision.decision === 'ALLOW' ? '許可' : `却下：${REASON_MESSAGES[decision.reason_code]}${policy}`,
    });
  }
  return {
    id: 'policy',
    label: 'Policy Engine の判断',
    message: '提案 → 本人が持つ権限 → 委譲できるか → 組織ポリシー → リスクポリシー の順に絞り、残ったものだけを許可しました。AI の意見はここでは使っていません。',
    fields,
  };
}

function constraintsSection(input: DecisionRecordInput): ActivityRecordSection | null {
  const entries = Object.entries(input.constraints);
  if (entries.length === 0) return null;
  return {
    id: 'constraints',
    label: '許可に付いた条件',
    message: '許可した権限に、組織ポリシーとリスクポリシーが付けた条件です。Agent はこの範囲でしかツールを使えません。',
    fields: entries.map(([capability, constraint]) => ({ label: capability, value: pairs(constraint) })),
  };
}

function profileSection(input: DecisionRecordInput): ActivityRecordSection {
  return {
    id: 'security_profile',
    label: '分離レベルの決め方',
    message: '性質とリスクポリシーの表から決めています。AI が分離レベルを言っても採用しません。',
    fields: [
      { label: '分離レベル', value: input.securityProfile.isolation_level },
      { label: 'リスクスコア', value: String(input.securityProfile.risk_score) },
      { label: '当てはまった理由', value: joined(input.securityProfile.reasons) },
      { label: '判断に使った性質', value: input.characteristics ? pairs(input.characteristics) : '—' },
    ],
  };
}

export function capabilityDecidedRecord(input: DecisionRecordInput): ActivityRecord {
  const denied = input.decisions.filter((decision) => decision.decision === 'DENY').length;
  const headline = input.status === 'no_capability_inferred'
    ? '許可できる権限はありませんでした'
    : `${input.effective.length} 件の権限を許可し、${denied} 件を却下しました`;
  const sections: ActivityRecordSection[] = [workDefinitionSection(input), proposalSection(input)];
  if (input.status === 'decided') {
    sections.push(policySection(input));
    const constraints = constraintsSection(input);
    if (constraints) sections.push(constraints);
  } else {
    sections.push({
      id: 'policy',
      label: 'Policy Engine の判断',
      message: 'Capability 一覧に残る提案が無かったため、Policy Engine には何も渡していません。Agent に許可できる権限はありません。',
    });
  }
  return { headline, checks: capabilityChecks(input), sections };
}

export function isolationDecidedRecord(input: DecisionRecordInput): ActivityRecord {
  return {
    headline: `分離レベルを ${input.securityProfile.isolation_level} に決めました（リスクスコア ${input.securityProfile.risk_score}）`,
    sections: [profileSection(input)],
    hops: [{
      from: 'authorization-platform', to: 'automation-app', label: '決定を返す', outcome: 'info',
      message: `決定 ${input.decisionId} を Automation App へ返しました。許可した権限は ${input.effective.length} 件です。`,
    }],
  };
}
