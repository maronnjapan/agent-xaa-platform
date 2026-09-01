# RULE と実装とテストの対応表

この表は手書きである。`rules.json` へルールを追加したら、同じコミットで行を足す。
守らないと決めたものは [逸脱レジストリ](./deviations.md) にあり、この表は守るものの台帳である。

| RULE-ID | ルール要旨 | 対応 REQ-ID | 実装ファイル | テスト（パス::テスト名） | 状態 |
|---|---|---|---|---|---|
| RULE-01 | Human IdentityとAgent Identityを | REQ-05-001 | `packages/xaa-logging/src/audit.ts` | `packages/xaa-logging/test/audit.spec.ts::throws when agent record lacks on_behalf_of` | 実装 |
| RULE-02 | Agent RuntimeはHuman Sessionと独立 | REQ-05-002 | `apps/agent-runtime/src/tokens/subject-token.ts` | `apps/agent-runtime/test/tool-executor.spec.ts::walks the seven steps and reaches the resource` | 実装 |
| RULE-03 | Agent Registration（client credential）をAgentごとに作る | REQ-05-024 | `apps/provisioner/src/agent/registration.ts` | `apps/provisioner/test/provisioning.spec.ts::writes a registration carrying no API detail` | 実装 |
| RULE-04 | 1 Agent = 1 Cloud Run Job Exec | REQ-05-050 | `apps/agent-runtime/src/main.ts` | `apps/agent-runtime/test/env.spec.ts::has no server, no port and no route` | 実装 |
| RULE-05 | GCP Service AccountはアプリがGCP IA | REQ-01-015 | `apps/agent-runtime/src/http/internal-invoker-token.ts` | `apps/agent-runtime/test/execution-context.spec.ts::is not serializable` | 実装 |
| RULE-06 | Human Control PlaneのAccess Tok（DEV-01） | REQ-05-013 | `packages/xaa-crypto/src/dpop.ts` | `packages/xaa-crypto/test/dpop.spec.ts::rejects htm mismatch` | 実装 |
| RULE-43 | Control Plane APIの `human_subj | REQ-05-054 | `packages/xaa-control-plane-auth/src/human-subject.ts` | `apps/lifecycle-manager/test/revoke-and-reprovision.spec.ts::ignores human_subject in the body` | 実装 |
| RULE-44 | DPoP検証では、Access Tokenの `cnf.jk（DEV-11） | REQ-05-034 | `packages/xaa-resource-guard/src/redeem.ts` | `apps/google-bridge/test/bridge.spec.ts::tells a missing proof apart from a bad one` | 実装 |
| RULE-07 | Automation Design AIはWork Defi | REQ-02-001 | `apps/automation-app/src/work-definition/submit.ts` | `apps/automation-app/test/work-and-approval.spec.ts::names no capability, scope, audience or tool` | 実装 |
| RULE-08 | ユーザーとの対話と承認なしに、Automation Desi | REQ-02-004 | `apps/automation-app/src/work-definition/model.ts` | `apps/automation-app/test/work-and-approval.spec.ts::stays DRAFT despite an LLM confirmation phrase` | 実装 |
| RULE-09 | Authorization AI AgentはWork De | REQ-03-004 | `apps/authorization/src/ai/taxonomy-filter.ts` | `apps/authorization/test/ai-guards.spec.ts` | 実装 |
| RULE-10 | Authorization AI Agentの出力は提案であ | REQ-03-005 | `apps/authorization/src/pipeline/decide.ts` | `apps/authorization/test/decide-pipeline.spec.ts` | 実装 |
| RULE-11 | Effective Agent Permission = P | REQ-03-010 | `apps/authorization/src/policy/effective.ts` | `apps/authorization/test/policy-engine.pure.spec.ts` | 実装 |
| RULE-12 | 最低Isolation LevelはPolicy Engin | - | `apps/authorization/src/policy/security-profile.ts` | `apps/authorization/test/policy-components.spec.ts` | 実装 |
| RULE-13 | 既存Agentの権限昇格は行わない。より広い権限が必要なら、 | - | `apps/automation-app/src/agents/instructions.ts` | `apps/automation-app/test/agent-operations.spec.ts::rejects a body that names a capability` | 実装 |
| RULE-14 | Human Permissionが縮小したら既存Agentを | - | `apps/lifecycle-manager/src/reprovision.ts` | `apps/lifecycle-manager/test/revoke-and-reprovision.spec.ts::keeps expires_at from the old agent and asks for a new id` | 実装 |
| RULE-15 | CapabilityとToolを分離する。Capabilit | - | `apps/authorization/src/policy/invariant.ts` | `apps/authorization/test/invariant.property.spec.ts` | 実装 |
| RULE-16 | Toolの認証方式、接続先、API Endpointは To | - | `packages/xaa-contracts/src/catalog-types.ts` | `apps/provisioner/test/catalog.spec.ts` | 実装 |
| RULE-17 | AgentはProvisioning済みのToolだけを選択 | - | `apps/agent-runtime/src/manifest/load.ts` | `apps/agent-runtime/test/manifest.spec.ts::manifest is deeply frozen` | 実装 |
| RULE-18 | AI（LLM）はToolを選び、認証とAPI実行はDeter | - | `apps/agent-runtime/src/reasoning/parse-tool-call.ts` | `apps/agent-runtime/test/tool-executor.spec.ts::ignores api_base_url and scope in llm output` | 実装 |
| RULE-19 | XAA設定（audience、resource、scope） | - | `apps/agent-runtime/src/tool-executor/steps/allowed-tools.ts` | `apps/agent-runtime/test/tool-executor.spec.ts::does not match by prefix or case` | 実装 |
| RULE-20 | Agent OPは判断しない。仕事はAgent認証、`sub | - | `apps/provisioner/src/catalog/resolve-tools.ts` | `apps/provisioner/test/catalog.spec.ts` | 実装 |
| RULE-21 | Native XAA ResourceではBridgeを使わ | - | `apps/agent-runtime/src/tool-executor/steps/select-redeemer.ts` | `apps/agent-runtime/test/tool-executor.spec.ts::resource as 500 does not call the bridge` | 実装 |
| RULE-22 | Refresh TokenとClient SecretをAg | - | `apps/google-bridge/src/token/response.ts` | `apps/google-bridge/test/bridge.spec.ts::is four keys, built fresh` | 実装 |
| RULE-23 | OAuth Redirectで `access_token` | - | `packages/xaa-contracts/src/redirect-guard.ts` | `packages/xaa-contracts/test/redirect-guard.spec.ts::refuses every forbidden key` | 実装 |
| RULE-24 | Bridge ConnectionはHuman Userごと | - | `apps/google-bridge/src/token/effective-scope.ts` | `apps/google-bridge/test/bridge.spec.ts::narrows only, never widens` | 実装 |
| RULE-45 | Cross App Accessは `draft-ietf-`準拠。外れる箇所は記録する | REQ-10-004 | `docs/deviations.md`、`scripts/check-deviations.mjs` | `tests/docs/docs-registry.spec.ts::has fifteen rows, DEV-01 to DEV-15 with no gaps` | 実装 |
| RULE-46 | ID-JAGの `sub` は委譲元の人間、`act` は代 | REQ-06-012 | `apps/google-bridge/src/token/resolve-binding.ts` | `apps/google-bridge/test/bridge.spec.ts::refuses when the binding names a different person` | 実装 |
| RULE-47 | Human IdPにAgentの文脈を持ち込まない。issuerは1つ | REQ-05-045 | `apps/human-idp/src/oidc/routes/discovery.ts`、`apps/agent-op/src/app.ts` | `apps/human-idp/test/discovery.spec.ts::advertises identity_chaining only in loadbalancer profile` | 実装 |
| RULE-48 | Agent OPのID-JAG署名鍵はHuman IdPのSSO鍵と別 | REQ-05-032 | `apps/agent-op/src/keys/publish-public-key.ts`、`apps/agent-op/src/idjag/sign-id-jag.ts` | `apps/agent-op/test/shared-jwks.spec.ts::subjectTokenJwks contains only idp-prefixed kids` | 実装 |
| RULE-49 | Token Exchangeでは `actor_token` と `subject_token` の一致を確認 | REQ-05-035 | `apps/agent-op/src/idjag/verify-delegation.ts` | `apps/agent-op/test/delegation.spec.ts::records delegation_check=true on match` | 実装 |
| RULE-50 | Agentごとのクライアント登録を作らない。`client_ | - | `apps/human-idp/src/security/reuse-detection.ts` | `apps/human-idp/test/refresh-rotation.spec.ts` | 実装 |
| RULE-51 | Human IdP ConnectionのRefresh T | - | `apps/lifecycle-manager/src/cleanup/steps/idp-connection-revoke.ts` | `apps/lifecycle-manager/test/cleanup-steps.spec.ts::names only this agent connection and never decrypts anything` | 実装 |
| RULE-52 | 各Resource ASにおける `agent-platfo | - | `apps/google-bridge/src/scope/subset.ts` | `apps/google-bridge/test/bridge.spec.ts::is indifferent to order and duplication` | 実装 |
| RULE-25 | Agentの最大生存期間は24時間とする | - | `apps/lifecycle-manager/src/cleanup/index.ts` | `apps/lifecycle-manager/test/cleanup.spec.ts::runs 11 steps in fixed order` | 実装 |
| RULE-26 | LifetimeはCloud Run timeoutだけに依 | - | `apps/lifecycle-manager/src/sweep.ts` | `apps/lifecycle-manager/test/routes-and-sweep.spec.ts::takes an expired agent to DESTROYED in a single tick` | 実装 |
| RULE-27 | 期限到達、ユーザーによる停止、異常検知のいずれでもAgent | - | `apps/lifecycle-manager/src/domain.ts` | `apps/lifecycle-manager/test/cleanup-steps.spec.ts::leaves nothing under agents/{agent_id} after step11` | 実装 |
| RULE-28 | Human Identityが無効化されたら、そのユーザーの | - | `apps/lifecycle-manager/src/subscribers/identity-disabled.ts` | `apps/lifecycle-manager/test/routes-and-sweep.spec.ts::revokes the six eligible statuses and skips the terminal three` | 実装 |
| RULE-29 | Agent OPとRuntimeはDisposableとし、 | - | `apps/lifecycle-manager/src/reprovision.ts` | `apps/lifecycle-manager/test/revoke-and-reprovision.spec.ts::destroys the old agent before asking for the new one` | 実装 |
| RULE-30 | Isolation LevelはSTANDARDとFULL_ | - | `apps/lifecycle-manager/src/state-machine.ts` | `apps/lifecycle-manager/test/state-machine.spec.ts::covers all 81 pairs` | 実装 |
| RULE-31 | STANDARDはShared OPのプロセスを共有してよい | - | `apps/agent-op/src/idjag/cap-exp.ts` | `apps/agent-op/test/idjag-exp.spec.ts` | 実装 |
| RULE-32 | FULL_ISOLATIONはDedicated OP、専用SA、専用Key、専用Job | REQ-07-020 | `apps/provisioner/src/dedicated.ts` | `apps/provisioner/test/boundary.spec.ts::refuses a Terraform-managed name` | 実装 |
| RULE-33 | Dedicated OPのSAは自分のAgentの鍵にだけ署名できる | REQ-07-021 | `apps/provisioner/src/dedicated.ts`、`packages/xaa-contracts/src/dedicated-iam.ts` | `apps/lifecycle-manager/test/dedicated-destroy.spec.ts::deletes in reverse creation order` | 実装 |
| RULE-34 | 実行系と監査ログを同一Project内でIAM分離（DEV-14） | REQ-08-035 | `infra/envs/shared/audit.tf`、`infra/tests/audit-iam.sh` | `packages/gcp/test/audit-separation.spec.ts::keeps the audit dataset authoritative and undeletable by the platform` | 実装 |
| RULE-35 | 責務分離はService Account、IAM、KMS K | - | `apps/resource-finance-api/src/middleware/isolation.ts` | `e2e/test/resource/finance-flow.spec.ts` | 実装 |
| RULE-36 | Cloud Run IAMはXAAの代替ではない。IAMは「 | - | `apps/google-bridge/src/token/resolve-binding.ts` | `apps/google-bridge/test/bridge.spec.ts::refuses when the binding names a different person` | 実装 |
| RULE-37 | Internetへ公開するのは、Automation App | - | `apps/agent-op/src/keys/dedicated-key.ts` | `apps/agent-op/test/dedicated-key.spec.ts` | 実装 |
| RULE-53 | 共有JWKSはCloud Storageから配信し、集約はJobが行う | REQ-05-032 | `apps/jwks-publish/src/index.ts`、`apps/agent-op/src/keys/publish-public-key.ts` | `apps/agent-op/test/publish-public-key.spec.ts::writes only keys/<kid>.json and never jwks.json` | 実装 |
| RULE-38 | Raw Token、Secret、Private Keyをロ | - | `packages/xaa-logging/src/redact.ts` | `packages/xaa-logging/test/redaction.spec.ts` | 実装 |
| RULE-39 | Raw Logをそのまま全部AIへ投入しない。Protoco | - | `apps/security-detection/src/ai/input.ts` | `apps/security-detection/test/detection.spec.ts::never carries the text of the work definition` | 実装 |
| RULE-40 | AgentごとのBaselineをAgent Definit | - | `apps/security-detection/src/pipeline/index.ts` | `apps/security-detection/test/detection.spec.ts::calls six stages in the declared order` | 実装 |
| RULE-41 | 異常なAgentをAgent Identity Domain | - | `apps/lifecycle-manager/src/cleanup/steps.ts` | `apps/lifecycle-manager/test/cleanup.spec.ts::is idempotent across three calls` | 実装 |
| RULE-42 | Platform側のService AccountにSecu（DEV-05 / DEV-14） | REQ-08-036 | `infra/envs/shared/audit.tf`、`infra/tests/forbidden-roles.json` | `packages/gcp/test/audit-separation.spec.ts::leaves no unexplained exception in the forbidden-role list` | 実装 |
| RULE-54 | Activity Monitoring UIは人間向けの可視 | REQ-11-001 | `apps/automation-app/src/ui/replay/emphasis.ts` | `apps/automation-app/test/ui.spec.ts::distinguishes a blocked security event from a blocked tool call` | 実装 |
| RULE-55 | Activity Eventは、Security Detec | REQ-11-010 | `packages/xaa-contracts/src/activity-publisher.ts` | `apps/automation-app/test/activity.spec.ts::names one topic` | 実装 |
| RULE-56 | Activity Feedの参照範囲はAccess Toke | REQ-11-013 | `apps/automation-app/src/activity/query.ts` | `apps/automation-app/test/activity.spec.ts::returns nothing of another user, however the request asks` | 実装 |
| RULE-57 | ブラウザはFirestoreへ直接アクセスしない。Activ（DEV-13） | REQ-11-014 | `apps/automation-app/src/activity/subscriber.ts` | `apps/automation-app/test/activity.spec.ts::writes once however many times the same event arrives` | 実装 |
| RULE-58 | デモ用に台本化したActivity Eventには`is_s | - | `apps/automation-app/src/ui/components/simulated-badge.tsx` | `apps/automation-app/test/ui.spec.ts::labels a simulated task everywhere and a real one nowhere` | 実装 |
| RULE-59 | Activity Timelineは実行中のイベントを逐次配 | - | `packages/xaa-contracts/src/task-boundary.ts` | `apps/automation-app/test/activity.spec.ts::hides the events of a task that has not ended` | 実装 |
| RULE-60 | Activity Eventの記録は、通常利用かデモかを区別 | - | `apps/automation-app/src/activity/emit.ts` | `apps/automation-app/test/activity.spec.ts::publishes one event each with the fixed phase, outcome and task` | 実装 |
