# 09. Agent Lifecycle Manager（T-LIFE）

Lifecycle Manager は、作られた Agent を止めて消すための単一の窓口である。
Agent は最大でも数時間から24時間で死ぬ短命な存在であり、期限到達、ユーザーによる停止、セキュリティ検知、人間の権限変更、人間の Identity 無効化のどれが起きても、その Agent に紐づく Identity と鍵と Config と Connection と実行中プロセスをまとめて破棄する必要がある。
このアプリはその破棄手順（Cleanup 11ステップ）と、Agent の状態遷移の唯一の書き込み経路と、定期実行の sweep と、権限縮小時の作り直し（Re-Provisioning）を持つ。
新しい Agent を作る処理は持たず、必要なときは Agent Provisioner の内部 API へ委譲する。
FULL_ISOLATION の Dedicated OP 一式については、Provisioner が実行時に作ったものを台帳に従って削除する。

| 前提 | 内容 |
|---|---|
| 依存する領域 | prov（Agent Provisioner の内部 API と Agent Registration の書式）、op（Agent OP の `/internal/*`）、res（Resource AS の `/internal/revoke-by-actor`）、authz（権限再評価からの Re-Provisioning 依頼）、sec（構造化ログと監査レコード）、iac（Cloud Scheduler、KMS Key Ring、Pub/Sub、endpoints.json）、bridge（Agent Binding の Disable、既定では無効） |
| このファイルのタスク数 | 17件 |
| 主に満たす設計ルール | RULE-25, RULE-26, RULE-27, RULE-28, RULE-29, RULE-32, RULE-33, RULE-41, RULE-43, RULE-51, RULE-55 |

このファイル内で共通に使う値を先に固定する。
アプリ名は `lifecycle-manager`、Service Account は `sa-lifecycle`、Cloud Run の ingress は INTERNAL_ONLY とする。
Cleanup の理由コードは `EXPIRED` / `USER_STOP` / `QUARANTINE` / `IDENTITY_DISABLED` / `REPROVISION` の5値に固定し、他の値を作らない。
unit テストは `apps/lifecycle-manager/test/*.spec.ts`、同一プロセス方式の integration テストは `e2e/test/lifecycle-*.spec.ts` に置く。

---

### T-LIFE-01 Lifecycle Manager アプリの骨格と Access Token 8項目検証を実装する

**概要**
Cloud Run Service 1つ分の Hono アプリを作り、外部から呼ばれる操作 API と内部専用 API のルーティングと認証を分ける。
人間の Access Token を受ける経路では docs 05 §2.1 の8項目を順に検証し、ボディの `human_subject` ではなく Access Token の `sub` を正とする（RULE-43）。
他人の Agent を停止できないようにする所有者照合ヘルパもここで作り、以降のタスクはこれを使う。
DEC-ID-13 が定める DPoP 適用経路の3番目（Automation App から Control Plane 3アプリ）の受け側にあたる。

**対象要件** REQ-05-016
**前提タスク** なし
**成果物**
- `apps/lifecycle-manager/package.json`
- `apps/lifecycle-manager/src/index.ts`（`createApp(): Hono` を default export）
- `apps/lifecycle-manager/src/server.ts`（`@hono/node-server` の起動エントリ）
- `apps/lifecycle-manager/src/config.ts`
- `apps/lifecycle-manager/src/middleware/access-token.ts`
- `apps/lifecycle-manager/src/middleware/internal-oidc.ts`
- `apps/lifecycle-manager/src/ownership.ts`
- `apps/lifecycle-manager/src/endpoints.ts`
- `apps/lifecycle-manager/test/access-token.spec.ts`
- `apps/lifecycle-manager/test/ownership.spec.ts`

**実装方針**
- ルートは `GET /healthz`（無認証）、`POST /agents/{agent_id}/revoke`、`POST /internal/tick`、`POST /internal/agents/{agent_id}/transition`、`POST /internal/agents/{agent_id}/reprovision` の5本だけを登録する。
- `access-token.ts` の `requireHumanAccessToken(scope: string)` は、(1) 署名と `iss` と `exp`、(2) `aud` に `lifecycle-manager` が要素として含まれるか、(3) `scope` に引数の値が含まれるか、(4) DPoP Proof の署名を Proof ヘッダの `jwk` で検証、(5) Access Token の `cnf.jkt` と `jwk` の thumbprint 一致、(6) `htm` と `htu` の一致、(7) `iat` 窓と `jti` 未使用、(8) ボディに `human_subject` があれば `sub` と一致、の順に実行する。失敗時のコードは1と2と4から7が 401、3と8が 403 とする。
- `aud` の判定は `packages/xaa-contracts/src/audience.ts` の要素一致関数を使う（DEV-12）。部分一致と接頭辞一致を書かない。
- 署名検証の直後に JOSE ヘッダの `typ` を検査し、`at+jwt` 以外は 401 `invalid_token` にする（DEC-ID-18）。
- DPoP の検証は `packages/xaa-crypto/src/dpop.ts` の `verifyDpopProof` を呼ぶ。`jti` 重複排除は Firestore `dpop_jti` を使い、TTL は `iat` 許容窓と同じ 300 秒にする。自前で JWT や Thumbprint の実装を書かない。
- `internal-oidc.ts` は Cloud Scheduler と他アプリの SA から届く Google 署名の OIDC ID Token を検証し、`email` が `sa-lifecycle` の呼び出し元許可リスト（`ALLOWED_CALLER_SAS` の CSV）に含まれるかを見る。含まれなければ 403 `caller_not_allowed`。
- `ownership.ts` の `assertAgentOwnership(agentId, sub)` は Firestore `agents/{agent_id}/meta` の `human_subject` を先に読み、ドキュメント不在なら `AgentNotFound`、不一致なら `ForbiddenSubject` を投げる。存在の有無を 403 と 404 で区別する点は REQ-07-025 の要求どおりとし、他の API では 404 に寄せない。
- Firestore へのアクセスはすべて `packages/xaa-contracts` の Firestore パスガード経由にし、`lifecycle-manager` の許可接頭辞を `agents/`、`idp_connections`、`dedicated_resources`、`provisioning_transactions`、`dpop_jti` の5つに限る（DEC-IAC-22）。
- `endpoints.ts` は起動時に `PLATFORM_ENDPOINTS_URI`（非公開 GCS の `endpoints.json`）を1回読み、Agent OP と Provisioner と Resource AS 2種と Bridge の URL をメモリに保持する。URL をコードへハードコードしない。
- 環境変数は `PROJECT_ID` / `REGION` / `FIRESTORE_DATABASE_ID`（既定 `xaa`）/ `ISSUER` / `SELF_AUDIENCE`（既定 `lifecycle-manager`）/ `PLATFORM_ENDPOINTS_URI` / `AGENT_MAX_LIFETIME_SECONDS` / `EXPIRING_WINDOW_SECONDS`（既定 60）/ `PUBSUB_MODE` / `STORE_MODE` の10個に固定する。

**完了条件**
- [ ] `pnpm --filter lifecycle-manager typecheck` と `pnpm --filter lifecycle-manager build` が成功する。
- [ ] `apps/lifecycle-manager/test/access-token.spec.ts::rejects wrong aud / missing scope / mismatched cnf.jkt / htu mismatch / replayed jti / non at+jwt typ` が緑で、6ケースそれぞれのステータスコードを assert している。
- [ ] `apps/lifecycle-manager/test/ownership.spec.ts::returns 404 for unknown agent / 403 for other subject` が緑。
- [ ] `curl -s localhost:8080/healthz` が 200 と `{"status":"ok"}` を返す。
- [ ] `grep -rn "\.well-known\|run\.app" apps/lifecycle-manager/src --include=*.ts` の結果が `endpoints.ts` 以外に無い。

---

### T-LIFE-02 Lifecycle 状態機械 transition() を実装する

**概要**
9状態と11遷移を1つの純粋関数に閉じ込め、Firestore の `status` 書き込み経路をこの関数の戻り値だけに限定する。
Security Detection からの CRITICAL Finding では ACTIVE から QUARANTINED への直行を許す必要があるため、この1本だけを明示的な引数で開ける形にする。
docs 07 §2 の3経路と docs 09 §6 の Response 遷移の両方をこの1ファイルで満たす。

**対象要件** REQ-07-002, REQ-09-047
**前提タスク** T-LIFE-01
**成果物**
- `apps/lifecycle-manager/src/state-machine.ts`
- `apps/lifecycle-manager/src/status-writer.ts`
- `apps/lifecycle-manager/test/state-machine.spec.ts`
- `scripts/check-status-write-path.sh`

**実装方針**
- `AgentStatus` を `CREATED` / `PROVISIONING` / `ACTIVE` / `EXPIRING` / `EXPIRED` / `SUSPICIOUS` / `QUARANTINED` / `REVOKED` / `DESTROYED` の union type にする。
- 許可遷移表 `ALLOWED_TRANSITIONS` に11本を書く。CREATED→PROVISIONING、PROVISIONING→ACTIVE、PROVISIONING→REVOKED、ACTIVE→EXPIRING、EXPIRING→EXPIRED、EXPIRED→REVOKED、ACTIVE→SUSPICIOUS、SUSPICIOUS→QUARANTINED、QUARANTINED→REVOKED、ACTIVE→REVOKED、REVOKED→DESTROYED。
- 関数シグネチャを `transition(from: AgentStatus, to: AgentStatus, options?: { severity?: 'CRITICAL' }): AgentStatus` にする。表に無い遷移は `InvalidTransitionError`（`code = 'invalid_transition'`）を投げる。ACTIVE→QUARANTINED だけは `options.severity === 'CRITICAL'` のときに限り成功させ、表そのものには足さない。これで REQ-07-002 の「11遷移以外は例外」と REQ-09-047 の「CRITICAL は直行可」を両立させる。
- 同一状態への遷移（`from === to`）も例外にする。冪等性は呼び出し側が現在値を読んで分岐して実現し、状態機械側で吸収しない。
- `status-writer.ts` の `writeStatus(agentId, to, options)` だけが Firestore `agents/{agent_id}/meta.status` を更新する。内部で `runTransaction` を張り、現在値を読んで `transition` を通し、`status` と `status_changed_at` と `status_reason` を同時に書く。
- `scripts/check-status-write-path.sh` は `apps/lifecycle-manager/src` と他アプリの `src` に対し、`meta.status` または `status:` を含む Firestore 書き込み呼び出しが `status-writer.ts` 以外に現れないことを grep で検査し、見つかれば非ゼロ終了する。CI の `infra-tests` ジョブへ入れる。
- 状態は Firestore の `agents/{agent_id}/meta` に持たせる。別コレクションを作らない。

**完了条件**
- [ ] `apps/lifecycle-manager/test/state-machine.spec.ts::covers all 81 pairs` が 9×9 の全組み合わせを回し、11件が成功し70件が `InvalidTransitionError` になることを assert する。
- [ ] 同ファイルの `::allows ACTIVE to QUARANTINED only with CRITICAL severity` が、severity なしで例外、`severity: 'CRITICAL'` で成功することを assert する。
- [ ] 同ファイルの `::rejects backward transitions` が QUARANTINED→ACTIVE と DESTROYED→ACTIVE と REVOKED→ACTIVE の3件で例外になることを assert する。
- [ ] `bash scripts/check-status-write-path.sh` が終了コード 0 を返し、`status-writer.ts` 以外へ書き込みを1行足すと非ゼロで落ちる。

---

### T-LIFE-03 Agent Identity Domain を破棄単位の1レコードとして定義する

**概要**
1つの Agent に属する Identity、Key、Config、Connection、Runtime の参照を1ドキュメントへ集め、Cleanup がこの1件を読むだけで処理対象を漏れなく列挙できるようにする（RULE-27, RULE-41）。
docs 01 §3.4 は `agent_identity_domains` テーブルとして書いているが、データストアを Firestore 1本にした DEC-IAC-09 と DEC-IAC-22 に合わせ、`agents/{agent_id}/meta` の1ドキュメントで表す。
Provisioner が書き、Lifecycle Manager が読んで消す関係を型で固定する。

**対象要件** REQ-01-020
**前提タスク** T-LIFE-01, T-PROV-11, T-PROV-12
**成果物**
- `packages/xaa-contracts/src/schema/agent-identity-domain.schema.json`
- `packages/xaa-contracts/src/agent-identity-domain.ts`
- `apps/lifecycle-manager/src/domain.ts`
- `apps/lifecycle-manager/test/domain.spec.ts`

**実装方針**
- JSON Schema の必須フィールドを `agent_id` / `human_subject` / `isolation_level` / `registration_id` / `kms_key_name` / `dedicated_op` / `job_execution_name` / `idp_connection_id` / `bridge_binding_ids` / `created_at` / `expires_at` / `status` / `cleanup_step_results` の13にする。`additionalProperties: false` と `strict` を守り、TypeScript 型は json-schema-to-ts で導出する（DEC-APP-05）。
- `isolation_level` は `standard` と `full_isolation` の2値。`dedicated_op` は `standard` のとき `null`、`full_isolation` のとき 0 以上の整数にする。Schema の `if/then` でこの対応を強制する。
- `bridge_binding_ids` は配列にし、`enable_google_bridge=false` の既定構成では空配列を入れる。省略可にしない。
- `kms_key_name` は専用 ID-JAG 署名鍵の完全修飾名（`projects/../locations/../keyRings/idjag-signing/cryptoKeys/..`）を入れる。STANDARD では共有鍵の名前を入れるが、Cleanup はこの値でローテーションを行わない（T-LIFE-09 で分岐する）。
- `domain.ts` の `loadDomain(agentId): Promise<AgentIdentityDomain>` は `agents/{agent_id}/meta` を読み、Ajv で検証してから返す。検証に落ちたら `DomainSchemaViolation` を投げ、Cleanup を中断せずステップ結果へ記録できるようにする。
- `deleteDomain(agentId)` は `agents/{agent_id}` を配下の `state` と `instructions` と `manifest` と `meta` ごと再帰削除する。単一ドキュメントの削除で済ませない。
- Provisioner 側の書き込みと同じ Schema を参照させるため、Schema は `packages/xaa-contracts` に置き、両アプリから import する。アプリ側で型を再定義しない。

**完了条件**
- [ ] `apps/lifecycle-manager/test/domain.spec.ts::rejects standard with dedicated resources / rejects full_isolation without dedicated resources` が緑。
- [ ] 同ファイルの `::deleteDomain removes state, instructions, manifest and meta` が、4サブドキュメントを作った後の削除で `agents/{agent_id}` 配下のドキュメント数が 0 になることを assert する。
- [ ] `pnpm --filter xaa-contracts test` が Schema の `additionalProperties: false` を破る入力を拒否するケースを含めて緑。
- [ ] `e2e/test/lifecycle-domain.spec.ts::provisioner writes a domain that lifecycle can load` が、Provisioner が書いた meta を `loadDomain` が検証なしエラーで読めることを assert する。

---

### T-LIFE-04 cleanupAgent の11ステップ枠組みと冪等性を実装する

**概要**
docs 07 §6 の Cleanup を、順序が固定された11ステップのオーケストレータとして実装する。
どのステップが落ちても後続を続行し、失敗を `cleanup_step_results` に残して次の sweep で再試行する構造をここで作る。
各ステップの中身は T-LIFE-05 から T-LIFE-09 で実装し、このタスクでは枠組みと状態遷移と再試行の制御に限る。

**対象要件** REQ-07-020, REQ-09-049
**前提タスク** T-LIFE-02, T-LIFE-03
**成果物**
- `apps/lifecycle-manager/src/cleanup/index.ts`
- `apps/lifecycle-manager/src/cleanup/steps.ts`（ステップ定義と実行順の配列）
- `apps/lifecycle-manager/src/cleanup/result.ts`
- `apps/lifecycle-manager/test/cleanup.spec.ts`

**実装方針**
- 公開関数は `cleanupAgent(agentId: string, reason: CleanupReason): Promise<CleanupOutcome>` の1本にする。`CleanupReason` は `EXPIRED` / `USER_STOP` / `QUARANTINE` / `IDENTITY_DISABLED` / `REPROVISION` の union type とする。
- ステップ ID を `runtime_cancel` / `issuance_disable` / `idp_connection_revoke` / `bridge_binding_disable` / `credential_revoke` / `client_credential_revoke` / `runtime_state_delete` / `dedicated_destroy` / `dedicated_sa_delete` / `registration_delete` / `audit_persist` の11個に固定し、この順の配列を `steps.ts` に持つ。順序を呼び出し側から差し替えられるようにしない。
- 各ステップは `{ id, run(ctx): Promise<'succeeded' | 'skipped'> }` のインタフェースにする。`ctx` は `{ domain, reason, clients, logger }` の4つだけを渡し、ステップ間で値を受け渡さない。
- ステップ結果は `agents/{agent_id}/meta.cleanup_step_results` に `{ step, status, attempts, last_error_code, updated_at }` の配列で保存する。`status` は `succeeded` / `failed` / `skipped` の3値。
- 既に `succeeded` か `skipped` のステップは再実行しない。これで 2回目以降の `cleanupAgent` は残りのステップだけを実行する。
- 例外は `steps.ts` の実行ループで捕捉し、`last_error_code` に丸めて記録して次のステップへ進む。1ステップの失敗で throw しない。
- 開始時に `status` を `REVOKED` へ遷移させる（既に REVOKED なら遷移しない）。11ステップすべてが `succeeded` か `skipped` になったときだけ `writeStatus(agentId, 'DESTROYED')` を呼ぶ。1件でも `failed` が残る間は DESTROYED にしない。
- 同一 Agent への同時実行は `agents/{agent_id}/meta.cleanup_lock`（`{ holder, acquired_at }`）を `runTransaction` で CAS して防ぐ。ロック保持は既定 300 秒で失効させ、失効したロックは奪える。
- `attempts` が `CLEANUP_MAX_ATTEMPTS`（既定 5）に達したステップは以後 `failed` のまま再試行せず、`cleanup_exhausted` を構造化ログへ出す。無限再試行を作らない。
- GCP リソースの削除 API をこのファイルから呼ばない。呼び出しは T-LIFE-09 に閉じる。

**完了条件**
- [ ] `apps/lifecycle-manager/test/cleanup.spec.ts::runs 11 steps in fixed order` が、記録された実行順が `steps.ts` の配列と完全一致することを assert する。
- [ ] 同ファイルの `::continues after a failing step and does not reach DESTROYED` が、任意の1ステップに失敗を注入したとき他10ステップが実行され `status` が REVOKED のままであることを assert する（11ステップそれぞれについてパラメタライズする）。
- [ ] 同ファイルの `::reaches DESTROYED on the second call after the failure is fixed` が緑。
- [ ] 同ファイルの `::is idempotent across three calls` が、3回連続呼び出しで例外が出ず各ステップの実処理呼び出し回数が1回ずつであることを assert する。
- [ ] 同ファイルの `::stops retrying after CLEANUP_MAX_ATTEMPTS` が緑。

---

### T-LIFE-05 Cleanup step1 と step2（Job Execution 停止と ID-JAG 発行停止）を実装する

**概要**
Cleanup の最初の2ステップとして、Cloud Run Job Execution の cancel と Agent OP への発行停止依頼を実装する。
docs 01 §4 の `LIFE -.-> AGENT` と `LIFE -.-> OP` の2本の破線がこれにあたる。
どちらも既に停止済みの対象へ再実行しても成功として扱い、sweep の多重起動でエラーにならないようにする。

**対象要件** REQ-01-027
**前提タスク** T-LIFE-04
**成果物**
- `apps/lifecycle-manager/src/cleanup/steps/runtime-cancel.ts`
- `apps/lifecycle-manager/src/cleanup/steps/issuance-disable.ts`
- `apps/lifecycle-manager/src/clients/cloud-run.ts`
- `apps/lifecycle-manager/src/clients/agent-op.ts`
- `apps/lifecycle-manager/test/cleanup-runtime-cancel.spec.ts`
- `apps/lifecycle-manager/test/cleanup-issuance-disable.spec.ts`

**実装方針**
- `cloud-run.ts` は `@google-cloud/run` の `ExecutionsClient` を使い、`cancelExecution({ name })` を呼ぶ。`name` は Domain の `job_execution_name` をそのまま使い、文字列連結で組み立て直さない。
- cancel の冪等化は3つの分岐で行う。gRPC コード 5（NOT_FOUND）は `skipped`、既に `CANCELLED` / `SUCCEEDED` / `FAILED` の Execution は `succeeded`、それ以外の失敗は例外にして枠組み側へ返す。
- `job_execution_name` が `null`（Execution 起動前に Cleanup へ入った場合）は `skipped` を返す。
- `agent-op.ts` の `disableIssuance(agentId)` は `POST /internal/agents/{agent_id}/disable-issuance` を呼ぶ。宛先ホストは Domain の `isolation_level` と `dedicated_op` から `endpoints.json` を引いて決め、STANDARD は共有 Agent OP、FULL_ISOLATION は `dedicated_resources` の台帳が持つ Dedicated OP の URL にする。
- 呼び出しは `packages/xaa-contracts` の `httpClient` ラッパ経由にする（DEC-TEST-01）。fetch を直接書かない。認証は `sa-lifecycle` の OIDC ID Token（audience は宛先 Cloud Run URL）を Authorization ヘッダへ付ける。
- Agent OP 側は Registration の `status` を `REVOKED` にし、既に `REVOKED` なら 200 を返す契約とする（エンドポイント本体の実装は領域 op が行う）。Lifecycle 側は 200 と 404 の両方を `succeeded` として扱い、404 は Registration が既に消えている場合とみなす。
- 5xx とタイムアウト（既定 10 秒）は例外にして再試行対象へ回す。リトライをこのステップの中でループさせない。
- Cloud Run Service の削除 API と Job 定義の削除 API を import しない。`ExecutionsClient` 以外のクライアントをこのファイルで使わない。

**完了条件**
- [ ] `apps/lifecycle-manager/test/cleanup-runtime-cancel.spec.ts::treats NOT_FOUND and already-finished executions as done` が緑。
- [ ] 同ファイルの `::does not call delete APIs` が、モックした Cloud Run クライアントの `deleteService` と `deleteJob` の呼び出し回数が 0 であることを assert する。
- [ ] `apps/lifecycle-manager/test/cleanup-issuance-disable.spec.ts::targets the dedicated OP for full_isolation agents` が、台帳の URL が呼ばれることを assert する。
- [ ] `e2e/test/lifecycle-expire-revoke.spec.ts::second invocation returns 200 and token exchange stays invalid_grant` が、期限切れ Agent に対し sweep を2回起動しても2回目がエラーにならず、その後の `/xaa/token` が `invalid_grant` を返すことを assert する。

---

### T-LIFE-06 Cleanup step3 として Human IdP Connection の Revoke と削除を実装する

**概要**
Agent ごとに払い出された Human IdP Connection の Refresh Token を Human IdP へ Revoke し、Connection レコードを消す。
Refresh Token を保持するのは Agent OP だけであり（RULE-51）、FULL_ISOLATION では専用の暗号鍵で暗号化されているため、Lifecycle Manager は復号せず Agent OP の内部 API へ委譲する。
同じユーザーの他 Agent の Connection と本人の SSO セッションを巻き込まないことがこのステップの要点である。

**対象要件** REQ-05-053
**前提タスク** T-LIFE-05
**成果物**
- `apps/lifecycle-manager/src/cleanup/steps/idp-connection-revoke.ts`
- `apps/lifecycle-manager/src/clients/agent-op.ts`（`revokeIdpConnection` を追加）
- `apps/lifecycle-manager/test/cleanup-idp-revoke.spec.ts`
- `e2e/test/lifecycle-idp-revoke.spec.ts`

**実装方針**
- `revokeIdpConnection(agentId, idpConnectionId)` は Agent OP の `POST /internal/idp-connections/{idp_connection_id}/revoke` を呼ぶ。Lifecycle Manager から KMS の `decrypt` を呼ばず、`sa-lifecycle` に `idp-connection-encryption` 鍵の権限を与えない（DEC-IAC-08）。
- Agent OP 側の契約は、(1) 保存済み暗号化 Refresh Token を復号、(2) Human IdP の `/revoke`（RFC 7009、`token_type_hint=refresh_token`、`client_id=agent-platform`）へ送信、(3) `idp_connections/{id}` の `status` を `REVOKED` にして `encrypted_refresh_token` フィールドを `FieldValue.delete()` で消す、の3つとする。行そのものは監査のため残し、`revoked_at` を書く。
- Human IdP の `/revoke` は RFC 7009 に従い未知トークンでも 200 を返すため、Lifecycle 側は 200 と 404 を `succeeded`、`idp_connection_id` が `null` の場合を `skipped` として扱う。
- 対象は `agent_id` が一致する Connection 1件だけにする。`human_subject` で検索する経路と、複数件をまとめて Revoke する経路を作らない。
- Human IdP のセッション Cookie とログアウトエンドポイントに触れない。`/logout` を呼ぶコードを書かない。
- 失敗時のエラーコードは `idp_revoke_failed` に統一し、Revoke 応答の本文をログへ出さない（Refresh Token が混入しうるため）。

**完了条件**
- [ ] `apps/lifecycle-manager/test/cleanup-idp-revoke.spec.ts::calls agent-op once with the agent's connection id only` が緑。
- [ ] 同ファイルの `::treats 404 and null connection id as done` が緑。
- [ ] 同ファイルの `::never calls KMS decrypt` が、KMS クライアントのモックの呼び出し回数 0 を assert する。
- [ ] `e2e/test/lifecycle-idp-revoke.spec.ts::revoking agent A keeps agent B connection and the SSO session` が、A の Refresh Token での `grant_type=refresh_token` が `invalid_grant`、B のそれが 200、ブラウザセッションでの `/authorize` が再ログインを求めないことを assert する。
- [ ] `idp_connections/{id}` に `encrypted_refresh_token` フィールドが存在しないことを同 e2e で assert する。

---

### T-LIFE-07 Cleanup step4 と step5（Binding 無効化と発行済み Credential の Revoke）を実装する

**概要**
Agent OP を止めても、既に払い出された Access Token と Bridge 経由の SaaS Access Token は生きている。
step4 で Bridge の Agent Binding を無効化し、step5 で Native Resource AS 2種に `act.sub` 単位の一括失効を依頼する。
外部 SaaS の Refresh Token の Revoke は、他 Agent の Connection を壊すため異常時に限る。

**対象要件** REQ-07-021
**前提タスク** T-LIFE-06
**成果物**
- `apps/lifecycle-manager/src/cleanup/steps/bridge-binding-disable.ts`
- `apps/lifecycle-manager/src/cleanup/steps/credential-revoke.ts`
- `apps/lifecycle-manager/src/clients/bridge.ts`
- `apps/lifecycle-manager/src/clients/resource-as.ts`
- `apps/lifecycle-manager/test/cleanup-credential-revoke.spec.ts`

**実装方針**
- step4 は Domain の `bridge_binding_ids` を順に `POST /internal/agent-bindings/{binding_id}/disable`（Bridge の内部 API、T-BRIDGE-08 が実装）へ渡す。配列が空、または `enable_google_bridge=false` により Bridge の URL が `endpoints.json` に無い場合は `skipped` を返す。
- step5 は3つの処理からなる。(a) `resource-docs-as` と `resource-finance-as` の `POST /internal/revoke-by-actor` を必ず両方呼ぶ。(b) Bridge Binding の無効化は step4 で済んでいるものとし、step5 で再実行しない。(c) `reason` が `QUARANTINE` または `IDENTITY_DISABLED` のときだけ Bridge の `POST /internal/connections/{connection_id}/revoke-upstream` を呼び、SaaS の revocation endpoint へ Refresh Token を送って Connection を `REVOKED` にする。
- `revoke-by-actor` のリクエストボディは `{ "actor_sub": "urn:xaa:agent:<agent_id>" }` の1フィールドに固定する。`human_subject` を渡さない。`act.sub` の名前空間正規化は `packages/xaa-contracts/src/actor-token.ts` の関数を使う（DEC-ID-10）。
- `reason` が `EXPIRED` / `USER_STOP` / `REPROVISION` のときに (c) の経路へ入る分岐を書かない。条件式を1か所（`isAbnormalReason(reason)`）に集約し、各呼び出し箇所で個別に判定しない。
- 2つの Resource AS のどちらか一方が失敗しても、もう一方を呼んでからステップ全体を `failed` にする。片方の失敗で早期 return しない。
- Bridge が既定で無効な構成でもこのステップが `failed` にならないことを、`skipped` の扱いで保証する。

**完了条件**
- [ ] `apps/lifecycle-manager/test/cleanup-credential-revoke.spec.ts::calls revoke-by-actor on both resource AS for every reason` が、5つの `reason` すべてで docs と finance の両方が1回ずつ呼ばれることを assert する。
- [ ] 同ファイルの `::calls upstream SaaS revoke only for QUARANTINE and IDENTITY_DISABLED` が、`EXPIRED` と `USER_STOP` と `REPROVISION` で呼び出し回数 0、残り2つで1回、かつ Connection が `REVOKED` になることを assert する。
- [ ] 同ファイルの `::sends actor_sub in urn:xaa:agent form` が緑。
- [ ] 同ファイルの `::calls the second resource AS even when the first fails` が緑。
- [ ] `enable_google_bridge=false` 相当の `endpoints.json` を与えたとき step4 が `skipped` になることを同ファイルで assert する。

---

### T-LIFE-08 Cleanup step6 と step7 と step10 と step11 を実装する

**概要**
残る4ステップとして、Agent Client Credential の失効、Runtime State の削除、Agent Registration と Config の削除、監査情報の保存を実装する。
step8 と step9 は Dedicated OP 一式の削除であり T-LIFE-09 で扱う。
Cleanup の後に Firestore へ何も残さないことをこのタスクで確定させる。

**対象要件** REQ-07-020
**前提タスク** T-LIFE-07
**成果物**
- `apps/lifecycle-manager/src/cleanup/steps/client-credential-revoke.ts`
- `apps/lifecycle-manager/src/cleanup/steps/runtime-state-delete.ts`
- `apps/lifecycle-manager/src/cleanup/steps/registration-delete.ts`
- `apps/lifecycle-manager/src/cleanup/steps/audit-persist.ts`
- `apps/lifecycle-manager/test/cleanup-tail-steps.spec.ts`

**実装方針**
- step6（`client_credential_revoke`）は Agent OP の `POST /internal/agents/{agent_id}/credentials/revoke` を呼び、Registration の `jwk_thumbprint` を削除して `client_credential_status` を `REVOKED` にさせる。これにより `client_assertion_jwt`（DEC-ID-11）の検証が以後失敗する。共有 ID-JAG 署名鍵をここで無効化しない。破棄予約は FULL_ISOLATION の専用鍵に限り T-LIFE-09 が行う。
- step7（`runtime_state_delete`）は `agents/{agent_id}/state` と `agents/{agent_id}/instructions` を削除する。`meta` はこの時点では残す（step11 の監査保存が読むため）。
- step10（`registration_delete`）は Agent OP の `POST /internal/agents/{agent_id}/delete` で Registration と XAA Static Config を消し、続けてローカルの `agents/{agent_id}/manifest` を削除する。
- step11（`audit_persist`）は Cleanup の要約を構造化ログとして1件出し、その後に `deleteDomain(agentId)` で `agents/{agent_id}` を配下ごと削除する。ログ項目は `agent_id` / `human_subject` / `isolation_level` / `dedicated_op` / `reason` / `started_at` / `finished_at` / `step_results` / `job_execution_name` / `idp_connection_id` / `bridge_binding_ids` の11項目にする。BigQuery への取り込みは Log Sink 経由とし、このアプリから BigQuery クライアントを呼ばない（T-SEC-06 が受ける）。
- ログ出力は共通ログヘルパ（`packages/xaa-contracts/src/logging.ts` の `emitStructuredLog`）経由に限る。Raw Token、Refresh Token、鍵素材、JWT 形式文字列を含めない（RULE-38）。
- 各ステップは対象が既に無い場合に `skipped` を返す。削除前に存在確認の読み取りを行い、`NOT_FOUND` を例外にしない。

**完了条件**
- [ ] `apps/lifecycle-manager/test/cleanup-tail-steps.spec.ts::leaves nothing under agents/{agent_id} after step11` が、`state` と `instructions` と `manifest` と `meta` のすべてが消えることを assert する。
- [ ] 同ファイルの `::does not disable the shared idjag key for standard agents` が、KMS の `disableCryptoKeyVersion` 呼び出し回数 0 を assert する。
- [ ] 同ファイルの `::audit log has the 11 required fields and no JWT-shaped string` が緑。
- [ ] 同ファイルの `::each tail step is skipped when the target is already gone` が緑。
- [ ] `e2e/test/lifecycle-cleanup.spec.ts::registration, idp connection, bridge binding and runtime state are all gone` が緑。

---

### T-LIFE-09 Cleanup step8 と step9 で Dedicated OP 一式を削除する

**概要**
docs 07 §6 の step8 と step9 のとおり、FULL_ISOLATION の Dedicated Cloud Run Service と ID-JAG 署名鍵と Service Account を実行時に削除する（DEC-IAC-07）。
これらは Terraform の管理対象外であり、消しても state と食い違わない。
消す対象は `dedicated_resources/{agent_id}.created` の台帳から取り、名前を組み立て直さない。

**対象要件** REQ-07-023, REQ-08-010
**前提タスク** T-LIFE-08, T-PROV-26
**成果物**
- `apps/lifecycle-manager/src/cleanup/steps/dedicated-destroy.ts`
- `apps/lifecycle-manager/src/cleanup/steps/dedicated-sa-delete.ts`
- `apps/lifecycle-manager/src/dedicated.ts`
- `apps/lifecycle-manager/src/clients/kms.ts`
- `apps/lifecycle-manager/test/dedicated-destroy.spec.ts`
- `infra/tests/runtime-mutation-scope.sh`（Lifecycle Manager を検査対象に追加）

**実装方針**
- STANDARD の Agent では step8 と step9 の両方を `skipped` にし、理由コード `no_dedicated_resources` を結果へ記録する。
- 削除対象は `dedicated_resources/{agent_id}.created` を**逆順**に読んで決める。
  作成の逆順で消すことで、IAM Binding が残ったまま Service Account を消す状態を作らない。
- step8（`dedicated_destroy`）が消すのは4種とする。
  `cloud_run_job` を `deleteJob` で消す。
  `cloud_run_service` を `deleteService` で消す。
  `crypto_key` の各鍵バージョンを `destroyCryptoKeyVersion` で破棄予約する。
  `iam_binding` を対象リソースの IAM Policy から取り除く。
- KMS の CryptoKey は GCP の仕様で削除できない。
  鍵バージョンの破棄予約までを行い、空の CryptoKey を Key Ring に残す（DEC-IAC-25）。
  破棄予約された鍵バージョンには課金が発生しないため、残っても費用は増えない。
  破棄予約と同時に JWKS バケットの `keys/idjag-<short>-<version>.json` を削除する。
- step9（`dedicated_sa_delete`）は `service_account` を `deleteServiceAccount` で消す。
  削除した Service Account の ID は30日間再利用できないが、`<short>` は `agent_id` の乱数部から導くため衝突しない。
  この点を実装のコメントに書く。
- 消す前に必ず `assertRuntimeName(name)`（T-PROV-24 と同じ関数を `packages/xaa-contracts` 経由で共有する）を通す。
  `dedicated-op-` / `sa-op-` / `sa-agent-` / `idjag-` / `idpconn-` / `agent-runtime-` の6接頭辞で始まらない名前を渡したら例外にし、削除を実行しない。
  Terraform 管理のリソースを消す事故をここで止める。
- 各リソースの削除が成功するたびに、台帳の該当要素へ `deleted_at` を書く。
  まとめて最後に書かない。
  途中で落ちても、残っているものが台帳から分かるようにする。
- 削除は冪等にする。
  対象が既に存在しない場合（`NOT_FOUND`）は成功として扱い、`deleted_at` を書いて次へ進む。
- すべての要素に `deleted_at` が付いたら `dedicated_resources/{agent_id}.status` を `RELEASED` にする。
  台帳のドキュメント自体は消さない。
  掃除（T-LIFE-10）と監査がこの記録を使う。
- `infra/tests/runtime-mutation-scope.sh` の検査対象に `apps/lifecycle-manager/src` を加える。
  削除系 API の呼び出しが `assertRuntimeName` を通る経路にだけ現れることと、Terraform 管理の名前が文字列リテラルとして削除呼び出しの引数に現れないことを検査する。

**完了条件**
- [ ] `apps/lifecycle-manager/test/dedicated-destroy.spec.ts::deletes in reverse creation order` が緑で、Job、Service、鍵バージョン、IAM Binding、Service Account の順を assert する。
- [ ] 同ファイルの `::skips both steps for standard agents` が緑で、理由コード `no_dedicated_resources` を assert する。
- [ ] 同ファイルの `::treats NOT_FOUND as success and is idempotent on second run` が緑。
- [ ] 同ファイルの `::refuses to delete a terraform-managed name` が、`human-idp` を台帳に混ぜたとき例外になり削除 API が1回も呼ばれないことを assert する。
- [ ] 同ファイルの `::schedules key version destruction and never calls deleteCryptoKey` が緑。
- [ ] `bash infra/tests/runtime-mutation-scope.sh` が終了コード 0 を返す。
- [ ] `e2e/test/lifecycle-dedicated-destroy.spec.ts::old kid fails verification and dedicated service is gone` が緑で、FULL_ISOLATION の E2E 実行後に `terraform plan -detailed-exitcode` が 0 を返す。

---

### T-LIFE-10 定期 sweep と EXPIRING / EXPIRED 判定を実装する

**概要**
Cloud Scheduler から定期起動され、期限に達した Agent を状態遷移させて Cleanup を起動する入口を作る。
失敗したステップが残る Agent の再試行と、放置された Provisioning Transaction の始末もここで行う。
多重起動されても Cleanup の各ステップが二重に走らないようにする。

**対象要件** REQ-07-024
**前提タスク** T-LIFE-04, T-LIFE-09
**成果物**
- `apps/lifecycle-manager/src/routes/tick.ts`
- `apps/lifecycle-manager/src/sweep.ts`
- `apps/lifecycle-manager/test/sweep.spec.ts`
- `e2e/test/lifecycle-sweep.spec.ts`

**実装方針**
- エンドポイントは `POST /internal/tick` にする。REQ-07-024 の `POST /sweep` は、内部専用ルートを `/internal/` 配下に置くこのリポジトリの規約に合わせて改名したものであり、別名のエイリアスを作らない。認証は T-LIFE-01 の `internal-oidc.ts` で行い、呼び出し元を Cloud Scheduler の SA に限る。
- 実行順は (a) EXPIRING 判定、(b) EXPIRED 判定と Cleanup 起動、(c) 失敗ステップの再試行、(d) Transaction の ABANDONED 化、(e) 孤児となった実行時作成リソースの掃除 の5段に固定する。
- (a) は `status == ACTIVE` かつ `expires_at - now <= EXPIRING_WINDOW_SECONDS`（既定 60）の Agent を `EXPIRING` へ遷移させる。Cleanup は起動しない。
- (b) は `expires_at <= now` かつ `status` が `ACTIVE` / `EXPIRING` / `EXPIRED` のいずれかの Agent について、`EXPIRING` を経由して `EXPIRED` まで遷移させたうえで `cleanupAgent(agentId, 'EXPIRED')` を呼ぶ。ACTIVE から EXPIRED への直行は状態機械が拒否するため、同一 tick 内で2回 `writeStatus` を呼ぶ。
- (c) は `status == REVOKED` かつ `cleanup_step_results` に `failed` を含む Agent に対し `cleanupAgent(agentId, 元の reason)` を再実行する。`reason` は `meta.cleanup_reason` に保存しておいた値を使い、`EXPIRED` へ書き換えない。
- (d) は `provisioning_transactions` のうち `status` が `WAITING_EXTERNAL_CONSENT` または `IN_PROGRESS` で `created_at + TRANSACTION_TTL_SECONDS`（既定 1800）を過ぎたものを `ABANDONED` にする。Transaction に紐づく Agent が既に存在する場合はその Cleanup も起動する。
- (e) は DEC-IAC-25 の掃除である。ラベル `xaa-managed=runtime` を持つ Cloud Run Service と Job、`description` に `xaa-managed=runtime` を持つ Service Account、`idjag-signing` と `idp-connection-encryption` の Key Ring 内で `idjag-` と `idpconn-` で始まる CryptoKey を列挙し、ラベルの `xaa-agent-id` に対応する Agent が Firestore に存在しないか `status` が `DESTROYED` のものを削除対象にする。削除は T-LIFE-09 の `dedicated-destroy.ts` を再利用し、`assertRuntimeName` を必ず通す。
  Provisioner が作成の途中で落ちて台帳に記録できなかったリソースは、この経路だけが回収できる。台帳が空でもラベルから対象を特定できるようにするのが、ラベルを必須にした理由である。
  1回の tick で削除する件数の上限を `SWEEP_ORPHAN_LIMIT`（既定 10）にする。
- 1回の tick で処理する件数の上限を `SWEEP_BATCH_SIZE`（既定 50）にし、超過分は次回へ回す。応答は 200 と `{ scanned, expiring, expired, retried, abandoned, orphans_deleted }` の6カウンタにする。
- 多重起動の排他は T-LIFE-04 の `cleanup_lock` に任せ、sweep 全体を跨ぐグローバルロックを作らない。ロックを取れなかった Agent はその tick では飛ばし、カウンタに含めない。
- Firestore のクエリは `expires_at` と `status` の複合インデックスを前提にする。必要なインデックス定義は `infra/envs/demo/firestore.tf` へ追加する。

**完了条件**
- [ ] `apps/lifecycle-manager/test/sweep.spec.ts::moves ACTIVE to EXPIRING inside the window` が緑。
- [ ] 同ファイルの `::takes an expired agent to DESTROYED in a single tick` が緑。
- [ ] 同ファイルの `::two concurrent ticks call each cleanup step exactly once` が緑。
- [ ] 同ファイルの `::retries only failed steps and keeps the original reason` が緑。
- [ ] 同ファイルの `::deletes a labelled resource whose agent no longer exists` が緑。
- [ ] 同ファイルの `::leaves a labelled resource whose agent is still ACTIVE` が緑。
- [ ] 同ファイルの `::never deletes a resource without the xaa-managed label` が緑。
- [ ] 同ファイルの `::abandons stale provisioning transactions` が緑。
- [ ] `POST /internal/tick` を Cloud Scheduler 以外の SA の OIDC トークンで呼ぶと 403 になることを `apps/lifecycle-manager/test/sweep.spec.ts::rejects unknown caller` が assert する。

---

### T-LIFE-11 ユーザーによる Agent 停止 API を実装する

**概要**
Automation App の停止操作から呼ばれる公開 API を実装する。
人間の Access Token を8項目検証し、対象 Agent の所有者と一致する場合だけ REVOKED へ遷移させて Cleanup を起動する。
他人の Agent を止められないこと、停止済みへの再実行が壊れないことがこの API の要点である。

**対象要件** REQ-07-025
**前提タスク** T-LIFE-01, T-LIFE-04
**成果物**
- `apps/lifecycle-manager/src/routes/revoke.ts`
- `apps/lifecycle-manager/test/revoke-api.spec.ts`
- `e2e/test/lifecycle-revoke-api.spec.ts`

**実装方針**
- ルートは `POST /agents/{agent_id}/revoke`。`requireHumanAccessToken('agent:revoke')` を通し、`aud` は `lifecycle-manager` を要素として含むことを求める。
- 検証の順序を、8項目検証 → Agent 存在確認 → 所有者照合 → 状態判定 → Cleanup 起動 に固定する。所有者照合の前に状態を読んで応答を変えない。
- ステータスコードは、Agent が存在しないとき 404 `agent_not_found`、`human_subject` 不一致のとき 403 `forbidden_subject`、`status == DESTROYED` のとき 200 `{ "status": "DESTROYED" }`、それ以外は 202 `{ "status": "REVOKED", "cleanup": "started" }` とする。
- Cleanup は `cleanupAgent(agentId, 'USER_STOP')` を非同期に起動し、完了を待たずに 202 を返す。Cloud Run のリクエスト内で最後まで実行しきる前提を置かず、失敗分は sweep が再試行する。
- 遷移は `writeStatus(agentId, 'REVOKED', { reason: 'USER_STOP' })` の1回だけにする。ACTIVE 以外（EXPIRING、SUSPICIOUS、QUARANTINED）からの停止も同じ経路で受ける。CREATED と PROVISIONING は状態機械が REVOKED を許すため、そのまま通す。
- ボディは受け取らない。`Content-Length` が 0 でない場合も本文を読まず、`human_subject` をボディから取らない（RULE-43）。
- 監査ログを1件出し、`actor_type=human`、`on_behalf_of=null`、`operation=agent.revoke`、`agent_id`、`result`（`accepted` / `denied`）、`denial_reason` を含める。403 と 404 のケースでも `denied` として出す。
- Activity Event の発行はこの API では行わない。`AGENT_STOPPED` は Automation App が出す（docs 11 §3.2）。Lifecycle 側の終端イベントは T-LIFE-16 で扱う。

**完了条件**
- [ ] `apps/lifecycle-manager/test/revoke-api.spec.ts::returns 403 for another user's agent` が緑。
- [ ] 同ファイルの `::returns 202 and starts cleanup for the owner` が、`cleanupAgent` が `USER_STOP` で1回呼ばれることを assert する。
- [ ] 同ファイルの `::returns 200 for an already DESTROYED agent` が緑。
- [ ] 同ファイルの `::returns 404 before checking ownership for unknown agent` が緑。
- [ ] 同ファイルの `::ignores human_subject in the body` が、ボディに他人の `human_subject` を入れても Access Token の `sub` で照合されることを assert する。
- [ ] 同ファイルの `::writes an audit log for denied requests` が 403 と 404 の両方で緑。

---

### T-LIFE-12 SUSPICIOUS と QUARANTINED の遷移 API を実装する

**概要**
Security Detection からの遷移依頼を受ける内部 API を作り、QUARANTINED の効果を Identity 面の停止に限定する。
QUARANTINED では ID-JAG 発行と subject_token 再取得を止め、Bridge Binding を無効化するが、Job Execution は止めない。
証拠保全のため、実行中プロセスの停止は REVOKED への遷移まで遅らせる。

**対象要件** REQ-07-026
**前提タスク** T-LIFE-02, T-LIFE-05, T-LIFE-07
**成果物**
- `apps/lifecycle-manager/src/routes/transition.ts`
- `apps/lifecycle-manager/src/quarantine.ts`
- `apps/lifecycle-manager/test/quarantine.spec.ts`
- `e2e/test/lifecycle-quarantine.spec.ts`

**実装方針**
- ルートは `POST /internal/agents/{agent_id}/transition`。ボディは `{ to: AgentStatus, severity?: 'CRITICAL', finding_id?: string, reason: CleanupReason }` の4フィールドに固定し、Ajv で `additionalProperties: false` を強制する。
- 認証は `internal-oidc.ts` で行い、呼び出し元を Security Detection の SA に限る。人間の Access Token では呼べないようにする。
- `to` が `SUSPICIOUS` のときは `writeStatus` のみを行い、外部呼び出しを1つも発生させない。監視の強化はログ側の責務であり、このアプリでは状態だけを変える。
- `to` が `QUARANTINED` のときは `quarantine(agentId)` を呼ぶ。処理は (1) `writeStatus(agentId, 'QUARANTINED', { severity })`、(2) Agent OP の `disable-issuance`（T-LIFE-05 のクライアントを再利用）、(3) Bridge Agent Binding の Disable（T-LIFE-07 のクライアントを再利用）、の3つだけにする。
- `quarantine` から `cancelExecution` を呼ばない。Firestore `agents/{agent_id}/state` への書き込み権限も落とさず、Runtime が Checkpoint を書き続けられる状態を保つ。
- Agent OP 側は QUARANTINED の Registration に対し `/xaa/token` と `/xaa/subject-token` の両方を `invalid_grant` にする契約とする。Lifecycle 側はこの契約を integration テストで固定する。
- `to` が `REVOKED` のときは `cleanupAgent(agentId, reason)` を起動し、その step1 で初めて Job Execution が cancel される。
- 応答は 202 と `{ from, to }`。状態機械が拒否した遷移は 409 `invalid_transition` にし、例外をそのまま 500 にしない。

**完了条件**
- [ ] `apps/lifecycle-manager/test/quarantine.spec.ts::disables issuance and binding but never cancels the execution` が、`cancelExecution` の呼び出し回数 0 を assert する。
- [ ] 同ファイルの `::cancels the execution only after the REVOKED transition` が緑。
- [ ] 同ファイルの `::returns 409 for a disallowed transition` が緑。
- [ ] 同ファイルの `::accepts ACTIVE to QUARANTINED with severity CRITICAL` が緑。
- [ ] `e2e/test/lifecycle-quarantine.spec.ts::token exchange and subject-token both fail right after quarantine` が緑で、同テストで Firestore `agents/{agent_id}/state` への書き込みが成功することも assert する。

---

### T-LIFE-13 reprovision() を実装する

**概要**
人間の権限が縮小したとき、既存 Agent を作り直す一連の手順を実装する（RULE-14, RULE-29）。
権限を書き換えて延命する経路を作らず、必ず旧 Agent を破棄してから新 Agent を Provisioner へ依頼する。
生存時間を延ばさないため `expires_at` を引き継ぎ、途中状態を持ち込まないため Checkpoint を引き継がない。

**対象要件** REQ-07-029
**前提タスク** T-LIFE-04, T-LIFE-08, T-AUTHZ-14
**成果物**
- `apps/lifecycle-manager/src/reprovision.ts`
- `apps/lifecycle-manager/src/routes/reprovision.ts`
- `apps/lifecycle-manager/src/clients/provisioner.ts`
- `apps/lifecycle-manager/test/reprovision.spec.ts`
- `e2e/test/lifecycle-reprovision.spec.ts`

**実装方針**
- 公開関数は `reprovision(agentId: string, newEffectiveCapability: string[]): Promise<ReprovisionOutcome>`。入口は `POST /internal/agents/{agent_id}/reprovision` で、Authorization Platform の SA からのみ受ける。
- 手順を (1) 旧 Agent の情報退避、(2) `cleanupAgent(agentId, 'REPROVISION')`、(3) Provisioner の `POST /internal/provisioning/reprovision` 呼び出し、(4) 結果の記録と通知、の順に固定する。
- (1) では `work_definition_id` と `expires_at` と `human_subject` と `isolation_level` をメモリへ退避する。`agents/{agent_id}` は step11 で消えるため、Cleanup の前に読む。
- (2) が DESTROYED に到達しなかった場合は (3) へ進まず、`reprovision_blocked_by_cleanup` を返して sweep の再試行に任せる。旧 Agent が残ったまま新 Agent を作らない。
- (3) のリクエストボディは `{ work_definition_id, human_subject, effective_capabilities, isolation_level, inherited_expires_at, previous_agent_id }` の6フィールドに固定する。`requested_lifetime_hours` と `expires_at` の再計算値を送らない。
- 新 `agent_id` は Provisioner が新規採番する。旧 `agent_id` を再利用しない。Lifecycle 側で ID を組み立てない。
- 新 Agent の `expires_at` は `inherited_expires_at` をそのまま使う。Provisioner 側の24時間クランプ（T-PROV-16）は上限としてのみ働き、引き継いだ値を延長しない。
- 旧 Agent の `agents/{old_id}/state` を新 Agent へコピーする処理を書かない。Checkpoint の移送関数を実装しない。
- `inherited_expires_at` が現在時刻以下の場合は Provisioner を呼ばず、`reprovision_expired` を返して旧 Agent の Cleanup だけで終える。期限切れ間際の権限変更で寿命が延びないようにする。

**完了条件**
- [ ] `apps/lifecycle-manager/test/reprovision.spec.ts::keeps expires_at from the old agent` が緑。
- [ ] 同ファイルの `::allocates a new agent_id and never reuses the old one` が緑。
- [ ] 同ファイルの `::does not call the provisioner when cleanup fails` が緑。
- [ ] 同ファイルの `::returns reprovision_expired when the inherited expires_at is in the past` が緑。
- [ ] `e2e/test/lifecycle-reprovision.spec.ts::new agent starts with empty state and the old registration is gone` が、`agents/{new_id}/state` が空であることと `agents/{old_id}` が Firestore に無いことを assert する。

---

### T-LIFE-14 Re-Provisioning 不能時の中止と通知を実装する

**概要**
縮小後の Effective Capability では Work Definition を実行できない場合に、新 Agent を作らずに中止する分岐を実装する。
権限を失ったまま Agent を生かし続けないため、この場合も旧 Agent の Cleanup は完了させる。
ユーザーには不足している Capability を具体的に返す。

**対象要件** REQ-07-030
**前提タスク** T-LIFE-13
**成果物**
- `apps/lifecycle-manager/src/reprovision-guard.ts`
- `apps/lifecycle-manager/test/reprovision-insufficient.spec.ts`

**実装方針**
- `assertCapabilitiesSufficient(required: string[], granted: string[]): void` を純粋関数として作り、`required` が `granted` の部分集合でなければ `CapabilityInsufficientError`（`code = 'capability_insufficient'`、`missing_capabilities` を保持）を投げる。
- 判定は `packages/xaa-contracts` の Capability 定数表にある8件の値との厳密一致で行う。前方一致とワイルドカードの解釈を実装しない（DEC-SCOPE-03）。
- `required_capabilities` は Work Definition から取る。Provisioner を呼ぶ前に Lifecycle 側で判定し、Provisioner の応答を待たない。
- 判定の位置は `reprovision()` の (2) と (3) の間にする。Cleanup を先に完走させてから中止するため、判定を Cleanup より前へ移さない。
- 中止時は Provisioning Transaction を作らず、Authorization Platform が作成済みの Transaction がある場合はその `status` を `FAILED` にし、`failure_code = 'capability_insufficient'` と `missing_capabilities` を書く。
- 応答は 200 と `{ result: 'aborted', reason_code: 'capability_insufficient', missing_capabilities: [...] }` にする。エラーステータスにしない。呼び出し元にとって想定内の結果であるため。
- 通知ペイロードの生成は T-LIFE-16 の Activity Event 発行に渡す。ここでは `missing_capabilities` を組み立てるまでを担う。

**完了条件**
- [ ] `apps/lifecycle-manager/test/reprovision-insufficient.spec.ts::destroys the old agent and creates no new one` が、旧 Agent が DESTROYED になり Provisioner の呼び出し回数 0 であることを assert する。
- [ ] 同ファイルの `::reports every missing capability` が、2件不足のケースで `missing_capabilities` が2件とも含むことを assert する。
- [ ] 同ファイルの `::marks the transaction FAILED with capability_insufficient` が緑。
- [ ] 同ファイルの `::treats capability ids as exact strings` が、`document.read` を要求し `document.readonly` だけを与えたケースで不足と判定されることを assert する。

---

### T-LIFE-15 human-identity-disabled の購読と全 Agent 即時 Revoke を実装する

**概要**
人間の Identity が無効化されたら、そのユーザーの Agent を残り時間に関係なく即時に破棄する（RULE-28）。
Pub/Sub トピック `human-identity-disabled` を pull で購読し、対象 Agent を列挙して1体ずつ Cleanup する。
1体の失敗が他の Agent の処理を止めないようにする。

**対象要件** REQ-07-032
**前提タスク** T-LIFE-04, T-LIFE-10
**成果物**
- `apps/lifecycle-manager/src/subscribers/identity-disabled.ts`
- `apps/lifecycle-manager/src/subscribers/runner.ts`
- `apps/lifecycle-manager/test/identity-disabled.spec.ts`
- `e2e/test/lifecycle-identity-disabled.spec.ts`

**実装方針**
- 購読は pull にする（DEC-SEC-03）。`lifecycle-manager` は ingress=INTERNAL_ONLY のため push の宛先にしない。`runner.ts` は `createApp()` とは独立に起動し、`PUBSUB_MODE=inproc` のときはテスト用のインメモリ実装へ差し替える（DEC-APP-09）。
- メッセージのスキーマは `{ human_subject: string, disabled_at: string }` の2フィールドに固定し、Ajv で検証する。検証に落ちたメッセージは ack して `invalid_identity_disabled_event` を出す。再配信ループを作らない。
- 対象は `human_subject` が一致し `status` が `CREATED` / `PROVISIONING` / `ACTIVE` / `EXPIRING` / `SUSPICIOUS` / `QUARANTINED` のいずれかの Agent とする。`EXPIRED` と `REVOKED` と `DESTROYED` は対象外にし、進行中の Cleanup を二重起動しない。
- 各 Agent へ `writeStatus(agentId, 'REVOKED', { reason: 'IDENTITY_DISABLED' })` と `cleanupAgent(agentId, 'IDENTITY_DISABLED')` を順に実行する。`EXPIRING` からは状態機械が REVOKED を許さないため、`EXPIRING` の Agent はいったん `EXPIRED` を経由させる。
- 実行は逐次にし、1体ごとに try/catch で囲む。失敗した Agent は `failed_agents` に積み、全件処理後に構造化ログへ1件出す。例外を throw してメッセージを nack しない。
- 同じ `human_subject` の `provisioning_transactions` のうち終了状態でないものを `ABANDONED` にする。Agent 列挙より先に実行し、処理中に新しい Agent が作られる余地を減らす。
- `expires_at` の残り時間を見る分岐を書かない。待機と遅延実行を挟まない。
- 冪等性は `cleanupAgent` 側のステップ結果に任せる。同じメッセージが再配信されても各ステップは1回しか実処理を行わない。

**完了条件**
- [ ] `apps/lifecycle-manager/test/identity-disabled.spec.ts::revokes all six eligible statuses and skips the terminal three` が緑。
- [ ] 同ファイルの `::continues with the remaining agents when one cleanup throws` が、3体中1体に失敗を注入しても他2体が DESTROYED になることを assert する。
- [ ] 同ファイルの `::abandons in-flight provisioning transactions` が緑。
- [ ] 同ファイルの `::acks and logs invalid messages without redelivery` が緑。
- [ ] `e2e/test/lifecycle-identity-disabled.spec.ts::three agents and one transaction are settled by a single event` が緑。

---

### T-LIFE-16 Lifecycle の Activity Event 3種と Re-Provisioning の監査ログを実装する

**概要**
タイムラインへ出す `AGENT_EXPIRED` と `RE_PROVISIONED` と `AGENT_REVOKED_SECURITY` の3イベントを発行する。
`lifecycle` は Agent 終了を表す Task であり、終端イベントが記録されてから再生対象になるため（RULE-59）、Cleanup 完了後に1件だけ出す。
Re-Provisioning の中止時の通知と監査ログもここでまとめて扱う。

**対象要件** REQ-07-031, REQ-11-020
**前提タスク** T-LIFE-04, T-LIFE-13, T-LIFE-14, T-SEC-01
**成果物**
- `apps/lifecycle-manager/src/events.ts`
- `apps/lifecycle-manager/src/messages.ts`（人間向け説明文のテンプレート）
- `apps/lifecycle-manager/test/events.spec.ts`
- `e2e/test/lifecycle-events.spec.ts`

**実装方針**
- 発行関数は `publishActivityEvent(event: ActivityEvent)` の1本にし、Pub/Sub トピック `agent-activity-stream` へ publish する。`PUBSUB_MODE=inproc` では Automation App の `/internal/activity/push` へ直接配線する（T-APP-19 の受け口）。
- 3イベントの固定値は次のとおりにする。`AGENT_EXPIRED` は `phase=lifecycle` / `outcome=info` / `task_id=lifecycle`、`RE_PROVISIONED` は `phase=lifecycle` / `outcome=info` / `task_id=lifecycle`、`AGENT_REVOKED_SECURITY` は `phase=lifecycle` / `outcome=blocked` / `task_id=lifecycle`。`is_simulated` は常に `false` を入れる。
- 発行位置を1か所に固定する。`cleanupAgent` が DESTROYED へ到達した直後だけで、`reason` によって種別を選ぶ。`EXPIRED` は `AGENT_EXPIRED`、`QUARANTINE` と `IDENTITY_DISABLED` は `AGENT_REVOKED_SECURITY`、`USER_STOP` は発行しない（Automation App が `AGENT_STOPPED` を出すため）、`REPROVISION` は Cleanup 単体では発行せず `reprovision()` の完了時に `RE_PROVISIONED` を出す。
- DESTROYED に到達していない再試行中の Cleanup では発行しない。同じ Agent に対して2件目が出ないよう、`event_id` を `evt-{agent_id}-{event_type}` の決定的な値にして Automation App 側の冪等 create に載せる。
- `title` と `message` はこのアプリで生成する（RULE-55）。文面は `messages.ts` にテンプレートとして置き、`AGENT_EXPIRED` は「有効期限に達したため終了しました」、`RE_PROVISIONED` は「権限変更によりAgentを作り直しました」、`AGENT_REVOKED_SECURITY` は「セキュリティ上の理由でAgentを失効しました」を基本形にする。画面側で文章を組み立てない。
- `RE_PROVISIONED` の `detail` に `old_agent_id` と `new_agent_id` と `reason` を入れる。中止時は `agent.reprovision_failed` として `outcome=blocked`、`detail` に `reason_code` と `missing_capabilities` を入れる。
- 監査ログは Activity Event とは別に構造化ログとして出す（RULE-55 の別系統）。両方に対し、送出直前に JWT 形状（3つの `.` 区切り base64url セグメント）の値と `refresh_token` / `client_secret` / `private_key` を含むキー名を落とす。
- `related_finding_id` は Security Detection からの遷移依頼に `finding_id` が付いていた場合だけ設定し、それ以外は `null` にする。

**完了条件**
- [ ] `apps/lifecycle-manager/test/events.spec.ts::emits exactly one lifecycle event per destroyed agent` が、Cleanup を3回呼んでも publish が1回であることを assert する。
- [ ] 同ファイルの `::emits nothing before DESTROYED` が、失敗ステップを残した Cleanup で publish 回数 0 を assert する。
- [ ] 同ファイルの `::maps reason to event type` が5つの `reason` すべてについて緑。
- [ ] 同ファイルの `::payload contains no JWT-shaped string` が、成功と中止の両ケースで緑。
- [ ] `e2e/test/lifecycle-events.spec.ts::expired, reprovisioned and security-revoked paths each produce one event` が緑。

---

### T-LIFE-17 有効期限切れデモの Lifecycle 側経路を統合テストで固定する

**概要**
デモ D-3 は、寿命3分の Agent を作り、期限後の追加指示が Identity 層と Authorization 層と Connection 層のすべてで拒否されることを見せる。
このタスクではそのうち Lifecycle Manager が担う部分、つまり短寿命 Agent が sweep で EXPIRED へ進み Cleanup が完走して `AGENT_EXPIRED` が1件だけ出るところを integration テストで固定する。
ブラウザ操作を含む Playwright シナリオは T-APP-31 が書き、このタスクはその前提となるサーバ側の経路を保証する。

**対象要件** REQ-11-032
**前提タスク** T-LIFE-10, T-LIFE-16
**成果物**
- `e2e/test/lifecycle-expired-demo.spec.ts`
- `apps/lifecycle-manager/test/expiring-window.spec.ts`
- `infra/envs/demo/terraform.tfvars.verify`（検証プロファイルの変数値）

**実装方針**
- 検証プロファイルは `agent_max_lifetime_seconds = 3600`、`sweep_cron = "*/5 * * * *"`、`EXPIRING_WINDOW_SECONDS = 60` を既定とし、デモ用の短寿命は Work Definition の `requested_lifetime_hours = 0.05`（3分）で作る。Lifecycle 側に「デモ用の特別な寿命」を持ち込まず、通常の `expires_at` 判定だけで動かす。
- integration テストは同一プロセス方式で human-idp、agent-op、provisioner、lifecycle-manager、resource-docs-as、automation-app を `app.fetch` で配線し、時刻はテスト内の固定クロック（`vi.setSystemTime`）で進める。実時間を待つ `sleep` を書かない。
- テスト手順を (1) 3分寿命の Agent を Provision、(2) 期限前の Token Exchange が成功することを確認、(3) クロックを4分進める、(4) `POST /internal/tick` を1回呼ぶ、(5) 各層の拒否を確認、の5段で書く。
- 拒否の確認は3点にする。Agent OP の `/xaa/token` が `invalid_grant`（Registration の `expires_at` 判定）、ID-JAG の `exp` cap が現在時刻以下になり発行されないこと、`/xaa/subject-token` が IdP Connection の `expires_at` 超過で失敗すること。Bridge 経路の `expired_bridge_connection` は `enable_google_bridge=true` のときだけ実行するケースとして分ける。
- `AGENT_EXPIRED` が1件だけ publish されること、Cleanup 完了前には publish されないことを assert する。イベント数の assert を tick 1回目と2回目の両方で行う。
- Cleanup 完了後に `agents/{agent_id}` が Firestore に存在しないこと、`dedicated_resources` に割り当てが残っていないことを最後に確認する。
- Playwright の追加指示送信とタイムライン表示の確認をこのファイルへ書かない。重複した経路を2か所で持たない。

**完了条件**
- [ ] `e2e/test/lifecycle-expired-demo.spec.ts::token exchange fails with invalid_grant after expiry` が緑。
- [ ] 同ファイルの `::subject-token retrieval fails after the idp connection expires` が緑。
- [ ] 同ファイルの `::emits AGENT_EXPIRED exactly once across two ticks` が緑。
- [ ] 同ファイルの `::leaves no agent document and no dedicated resources` が緑。
- [ ] `apps/lifecycle-manager/test/expiring-window.spec.ts::a 3 minute agent passes ACTIVE, EXPIRING, EXPIRED and DESTROYED in order` が緑。
- [ ] `infra/envs/demo/terraform.tfvars.verify` を使った `terraform validate` が成功する。
