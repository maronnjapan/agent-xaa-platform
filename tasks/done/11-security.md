# 11. セキュリティ監視（T-SEC）

この領域は、8つのアプリが出す構造化ログを1本の経路で集め、Agent の異常を機械的に検知し、Lifecycle Manager へ隔離や失効を依頼する Security Detection アプリを作る。
併せて、全アプリが共通で使うログ出力ライブラリ（必須フィールドの強制、秘密情報の redaction、相関キーの生成）と、Cloud Logging から BigQuery へ流す Log Sink、検知の最小系となる保存済み SQL を作る。
検知は Telemetry Collection から Normalization、Protocol Validation、Rule-based Detection、Correlation、Risk Scoring の6段を固定順に通り、MEDIUM 以上だけが Security Finding となって Security AI 分析と Response へ進む。
判定そのものは各アプリが同期処理で行い、この領域はその結果を受け取って集約する側に徹する。
Security Detection から各アプリへ戻る同期呼び出しは作らない。

| 前提 | 内容 |
|---|---|
| 依存する領域 | 共通基盤（packages）、Identity（Agent OP、Human IdP、Resource AS）、Authorization、Provisioner、Lifecycle、Runtime、IaC、Activity Timeline |
| このファイルのタスク数 | 37件 |
| 主に満たす設計ルール | RULE-38, RULE-39, RULE-40, RULE-41, RULE-42, RULE-48, RULE-49 |

タスクは DEC-SEC-01 の段階に従って並ぶ。
T-SEC-01 から T-SEC-10 が第1段（構造化ログから BigQuery と保存済み SQL まで）、T-SEC-11 から T-SEC-15 が Protocol Validation、T-SEC-16 から T-SEC-18 がパイプライン骨格、T-SEC-19 から T-SEC-24 が Rule-based Detection、T-SEC-25 と T-SEC-26 が Agent Baseline、T-SEC-27 と T-SEC-28 が Correlation、T-SEC-29 から T-SEC-31 が Risk Score、T-SEC-32 と T-SEC-33 が Security AI、T-SEC-34 から T-SEC-36 が Response、T-SEC-37 が Isolation の検証である。

---

### T-SEC-01 共通構造化ログヘルパを実装する

**概要**
全アプリが同じ形の JSON をCloud Logging へ出すためのライブラリを作る。
`human_subject`、`agent_id`、`trace_id`、`timestamp` の4フィールドをキー欠落なしで必ず出すことを型と実行時の両方で強制する。
DEC-APP-03 の「2つ目のアプリが import したくなった時点で切り出す」規約に照らし、8アプリ全部が使うためこれを3つ目の共有パッケージとする。

**対象要件** REQ-09-003, REQ-08-028
**前提タスク** なし
**成果物**
- `packages/xaa-logging/package.json`
- `packages/xaa-logging/src/index.ts`
- `packages/xaa-logging/src/logger.ts`
- `packages/xaa-logging/src/types.ts`
- `packages/xaa-logging/schema/log-entry.schema.json`
- `packages/xaa-logging/test/logger.spec.ts`

**実装方針**
- `types.ts` に `LogSource` を10値の union で定義する。値は `human_idp` / `authz_ai` / `policy_engine` / `provisioner` / `agent_op` / `agent_op_idp_connection` / `google_bridge` / `native_resource_as` / `resource_api` / `agent_runtime` とする。
- `LogEntry` 型の必須フィールドを `severity`（`DEBUG` / `INFO` / `NOTICE` / `WARNING` / `ERROR` / `CRITICAL`）、`app`、`log_source`、`event`、`request_id`、`trace_id`、`agent_id: string | null`、`human_subject: string | null`、`timestamp`、`fields: Record<string, unknown>` の10個にする。`agent_id` と `human_subject` は optional にせず `| null` にして、キー欠落を型で作れないようにする。
- `createLogger(app: AppName, source: LogSource): Logger` を export する。`Logger` は `info` / `warning` / `error` / `critical` の4メソッドを持ち、いずれも `(event: string, ctx: LogContext, fields?: Record<string, unknown>)` を取る。`LogContext` は `request_id` / `trace_id` / `agent_id` / `human_subject` の4つで、すべて必須引数にする。
- 出力は `process.stdout.write(JSON.stringify(entry) + "\n")` の1行 JSON とする。`severity` は Cloud Logging が解釈するキー名のまま出す。`timestamp` は `new Date().toISOString()` で ISO 8601 の UTC にする。
- `console.log` を直接呼ぶことを禁じ、`packages/xaa-logging` 以外での `console.` の使用を ESLint の `no-console` で error にする。設定は `eslint.config.js` のルートに置く。
- JSON Schema `log-entry.schema.json` を Ajv（strict、`additionalProperties: false` は `fields` を除く）で検証する `assertLogEntry` を持ち、開発モード（`NODE_ENV !== 'production'`）でのみ実行する。
- redaction と fingerprint はこのタスクでは実装しない。`logger.ts` から `redact()` を呼ぶ差し込み口だけを作り、T-SEC-02 で中身を入れる。

**完了条件**
- [x] `pnpm --filter @xaa/logging test` が緑で、`test/logger.spec.ts::emits all four required keys even when null` が `agent_id` と `human_subject` に `null` が入った1行 JSON を出すことを検査する。
- [x] `test/logger.spec.ts::rejects entry missing trace_id` が Ajv 検証で例外になることを検査する。
- [x] `pnpm lint` が `apps/**` 内の `console.log` 呼び出しを1件でも含むと非ゼロ終了する。
- [x] `LogSource` の値が10個であることを `test/logger.spec.ts::log source has exactly ten values` が検査する。（実体は `packages/xaa-logging/test/logger.spec.ts`）

---

### T-SEC-02 秘密情報の redaction フィルタを実装する

**概要**
Raw Token や Private Key がログへ出ないよう、ログ出力関数の内側に二重の redaction を入れる。
フィールド名の deny list と、値の形状（JWT 形式または高エントロピー長文字列）の両方で判定する。
RULE-38 を実装で担保する部分であり、これが無いと以降の全ログが監査に使えない。

**対象要件** REQ-09-015, REQ-08-028
**前提タスク** T-SEC-01
**成果物**
- `packages/xaa-logging/src/redact.ts`
- `packages/xaa-logging/test/redaction.spec.ts`

**実装方針**
- `DENY_FIELD_NAMES` を定数配列で持つ。要素は `access_token` / `id_jag` / `dpop_proof` / `subject_token` / `actor_token` / `refresh_token` / `private_key` / `client_secret` / `code` / `authorization_code` / `client_assertion` / `assertion` の12個とする。比較はキー名を小文字化して完全一致で行い、部分一致にしない。
- `redact(value: unknown, depth = 0): unknown` を実装する。オブジェクトは再帰的に走査し、深さ8を超えたら `"[TRUNCATED]"` に置換する。配列も走査する。
- 値の形状判定は2つ。(1) `/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/` に一致する文字列は JWT とみなす。(2) 長さ40以上かつ Shannon エントロピーが 3.5 bits/char 以上の文字列を高エントロピーとみなす。どちらかに当たれば `"[REDACTED]"` に置換する。
- deny list に当たったキーは、値の形状によらず無条件で `"[REDACTED]"` にする。
- 置換後の値と一緒に `<key>_fingerprint` を出す処理はこのタスクでは行わない。T-SEC-03 で `redact` の後段として追加する。
- エントロピー計算は `redact.ts` 内の非 export 関数 `shannonEntropy(s: string): number` に閉じる。外部ライブラリを追加しない。
- 数値と真偽値と `null` はそのまま通す。文字列以外に形状判定を掛けない。

**完了条件**
- [x] `test/redaction.spec.ts::redacts nine secret kinds` が REQ-09-015 の9種（Raw Access Token、Raw ID-JAG、Raw DPoP Proof、Raw subject_token、Raw actor_token、Refresh Token、Private Key、Client Secret、Authorization Code）を含むオブジェクトを渡し、出力に原文が1つも含まれないことを検査する。
- [x] `test/redaction.spec.ts::redacts jwt in unknown field name` が deny list に無いキー名（`note`）へ入れた JWT 文字列も `[REDACTED]` になることを検査する。
- [x] `test/redaction.spec.ts::keeps short low entropy strings` が `"doc_12"` や `"pending"` が置換されないことを検査する。
- [x] `test/redaction.spec.ts::truncates deep object at depth 8` が深さ9の入れ子で `[TRUNCATED]` を返すことを検査する。

---

### T-SEC-03 相関キーと Token fingerprint の生成関数を実装する

**概要**
redaction で消した値の代わりに、追跡に使える非可逆の相関キーを出す。
Token 系は `jti` と `kid` と `jkt` と fingerprint、鍵と Secret 系は thumbprint と `connection_id` と `idp_connection_id`、いずれにも当たらないものは `request_id` と `trace_id` を使う。
Agent 個体の識別を `cnf.jkt` と `act` とログの3つで行う（DEC-ID-22）ため、この関数がその3つ目を支える。

**対象要件** REQ-09-016, REQ-05-081
**前提タスク** T-SEC-02
**成果物**
- `packages/xaa-logging/src/fingerprint.ts`
- `packages/xaa-logging/src/correlation.ts`
- `packages/xaa-logging/test/correlation-key.spec.ts`

**実装方針**
- `tokenFingerprint(raw: string): string` を実装する。`node:crypto` の `createHash('sha256')` で digest を取り、hex 表現の先頭16文字を返す。base64url にしない。実装はこの1関数だけとし、他のどこにも同等の計算を書かない。
- `attachCorrelationKeys(fields: Record<string, unknown>): Record<string, unknown>` を実装する。redaction の後に呼び、deny list のキー `<name>` が存在した場合に `<name>_fingerprint` を追加する。追加は元のキーを消したうえで行う。
- JWT 形状の値については、payload を base64url デコードして `jti` と `iss` と `aud` と `sub` を、ヘッダから `kid` と `typ` と `alg` を取り出し、`<name>_jti` などの形で追加する。デコードに失敗した場合はフィールドを追加せず、`<name>_parse_error: true` だけを置く。署名検証はここで行わない。
- `cnf.jkt` は payload の `cnf.jkt` をそのまま `<name>_jkt` として出す。thumbprint の再計算は `packages/xaa-crypto` の RFC 7638 実装を import して使い、この場所に重複実装しない。
- fingerprint と相関キー以外の値をここで新規に生成しない。原文の長さや先頭数文字を出す分岐を作らない。
- `logger.ts` の出力パイプラインを `redact` → `attachCorrelationKeys` → `assertLogEntry` → 書き出し の固定順にする。

**完了条件**
- [x] `test/correlation-key.spec.ts::same token yields same fingerprint` と `::different tokens yield different fingerprints` が緑になる。
- [x] `test/correlation-key.spec.ts::fingerprint length is 16 regardless of input length` が長さ 20 と 4000 の入力で同じ長さ16を返すことを検査する。
- [x] `test/correlation-key.spec.ts::extracts jti kid typ jkt from id-jag` が ID-JAG を渡したとき `id_jag_jti` と `id_jag_kid` と `id_jag_typ` と `id_jag_jkt` の4キーが出て、`id_jag` キーが消えていることを検査する。
- [x] `grep -rn "digest('hex').slice(0, 16)" packages apps | grep -v fingerprint.ts` が0件を返す。SHA-256 そのものは PKCE の `code_challenge`（RFC 7636）、Tool Manifest の SHA-256、`connection_id` と `finding_id` の導出でも使うため、重複を禁じる対象は Token fingerprint（16文字 hex）の再実装に限る。

---

### T-SEC-04 監査ログの主語3フィールドを強制する

**概要**
「Agent が人間の代理として行った」ことがログ1行で読めるよう、`actor_type` と `actor_id` と `on_behalf_of` の3フィールドを監査レコードに必須化する。
Agent の操作を `actor_type=human` として記録することを書き込み関数の側で禁止する。
RULE-01 をコードで固定する部分であり、Resource API と Control Plane の全アクセスログが対象になる。

**対象要件** REQ-01-002
**前提タスク** T-SEC-01
**成果物**
- `packages/xaa-logging/src/audit.ts`
- `packages/xaa-logging/test/audit.spec.ts`

**実装方針**
- `AuditRecord` 型を定義する。必須は `actor_type: 'human' | 'agent'`、`actor_id: string`、`on_behalf_of: string`、`operation: string`、`resource: string`、`outcome: 'allowed' | 'denied' | 'error'`、`occurred_at: string` の7つ。`on_behalf_of` を optional にしない。
- `writeAuditRecord(logger: Logger, ctx: LogContext, rec: AuditRecord): void` を実装する。書き込み前に3つのガードを順に評価する。(1) `actor_type === 'agent'` かつ `on_behalf_of` が空文字または未設定なら `AuditSubjectError` を throw する。(2) `actor_type === 'human'` かつ `on_behalf_of !== actor_id` なら `AuditSubjectError` を throw する。(3) `actor_type === 'agent'` かつ `actor_id` が `urn:xaa:agent:` で始まらないなら `AuditSubjectError` を throw する。
- `ctx.agent_id` が非 null なのに `actor_type === 'human'` の呼び出しも `AuditSubjectError` にする。Agent 経路の操作を人間名義で書けないようにするための4つ目のガードとする。
- 出力は `logger.info('audit', ctx, {...rec})` を通す。監査レコード専用の書き出し経路を別に作らない。
- 例外を握り潰して継続する分岐を作らない。呼び出し側で catch して握り潰すことも禁じ、`AuditSubjectError` を catch する記述が `apps/**` に無いことを CI で検査する。

**完了条件**
- [x] `test/audit.spec.ts::throws when agent record lacks on_behalf_of` が `AuditSubjectError` になることを検査する。
- [x] `test/audit.spec.ts::throws when human record has different on_behalf_of` が緑になる。
- [x] `test/audit.spec.ts::throws when agent_id present but actor_type is human` が緑になる。
- [x] `grep -rn "AuditSubjectError" apps/ | grep catch` が0件を返す CI ステップが通る。

---

### T-SEC-05 Identity 系5ログ源の出力項目を実装する

**概要**
docs 09 §2 の表のうち Identity 側5行（Human IdP、Agent OP、Agent OP の Human IdP Connection、Google Bridge、Native Resource AS）のログ項目を、各アプリの実処理に埋め込む。
表に挙がった項目を過不足なく出し、Raw Token は T-SEC-02 と T-SEC-03 の経路で相関キーへ置換された形で残す。
検知 SQL とルールの入力はこのログだけであるため、項目の欠落はそのまま検知不能を意味する。

**対象要件** REQ-08-028, REQ-05-081
**前提タスク** T-SEC-03, T-SEC-04
**成果物**
- `packages/xaa-logging/src/events/identity.ts`（イベント名と必須フィールドの表）
- `apps/human-idp/src/logging.ts`
- `apps/agent-op/src/logging.ts`
- `apps/google-bridge/src/logging.ts`
- `apps/resource-docs-as/src/logging.ts`
- `apps/resource-finance-as/src/logging.ts`
- `packages/xaa-logging/test/events-identity.spec.ts`

**実装方針**
- `events/identity.ts` に イベント名の定数を置く。`idp.authenticate` / `idp.token` / `agent_op.token_exchange` / `agent_op.subject_token` / `agent_op.idp_connection` / `bridge.token` / `resource_as.redeem` の7つとし、各イベントに必須フィールド名の配列を対にして持たせる。
- Human IdP は `client_id`、`audience`、`scope`、`auth_result`、`dpop_result`、`source_ip`、`user_agent` を出す。`source_ip` は `X-Forwarded-For` の左端1つだけを取り、リスト全体を出さない。
- Agent OP は `op_runtime_id`、`isolation_kind`（`shared` / `dedicated`）、`requested_audience`、`requested_resource`、`requested_scope`、`subject_token_iss`、`subject_token_aud`、`subject_token_sub`、`actor_token_sub`、`actor_token_jti`、`delegation_match`（真偽）、`dpop_result`、`issued_jti`、`issued_kid`、`issued_jkt`、`expiry_check`、`error_code` を出す。値は T-SEC-03 の相関キー抽出で自動的に埋まるものと明示指定するものを混ぜず、Agent OP 側で明示的に組み立てる。
- Agent OP の IdP Connection は `idp_connection_id`、`refresh_rotation_result`、`refresh_reuse_detected`（真偽）、`subject_token_refetch_result`、`revoke_result` を出す。
- Google Bridge は `id_jag_iss`、`id_jag_verify_result`、`connection_id`、`requested_resource`、`requested_scope`、`agent_expiry_check`、`google_refresh_result`、`access_token_issue_result` を出す。
- Native Resource AS は `id_jag_iss`、`id_jag_sub`、`id_jag_act`、`id_jag_client_id`、`audience`、`resource`、`scope`、`cnf_jkt`、`dpop_binding_result`、`token_issue_result`、`authz_decision`、`received_kid`、`received_typ` を出す。`received_kid` と `received_typ` は REQ-05-034 の突合に使うため、検証が失敗した経路でも必ず出す。
- ログ呼び出しを各ルートのハンドラ末尾1か所に集約し、途中の分岐から個別に呼ばない。エラー経路も同じ1か所を通す。

**完了条件**
- [x] `test/events-identity.spec.ts::every identity event declares its required fields` が7イベントすべてに必須フィールド配列が存在することを検査する。
- [x] 各アプリの integration テストで、`app.fetch` を1回呼んだあと捕捉した stdout の1行 JSON が該当イベントの必須フィールドをすべて持つことを検査するヘルパ `expectLogFields(line, eventName)` が緑になる。
- [x] `apps/resource-docs-as/test/logging.spec.ts::logs received kid and typ on verification failure` が、署名検証に失敗した ID-JAG でも `received_kid` と `received_typ` が出ることを検査する。
- [x] 上記5アプリのログ1行を JSON パースし `"eyJ"` で始まる値が1つも無いことを検査するテストが緑になる。（実体は `apps/security-detection/test/fixtures.spec.ts`）

---

### T-SEC-06 Control Plane と Runtime 系5ログ源の出力項目を実装する

**概要**
docs 09 §2 の残り5行（Authorization AI Agent、Policy Engine、Agent Provisioner、Resource API と Google API、Agent Runtime）のログ項目を実装する。
Work Definition の自然言語本文はここでも出さず、Hash と操作種別の配列に置き換える。
Rule-based Detection の Tool 分類と Lifetime 分類は、このログの `tool_id` と `agent_age_seconds` と `expires_at` を入力にする。

**対象要件** REQ-08-028, REQ-09-014
**前提タスク** T-SEC-03, T-SEC-04
**成果物**
- `packages/xaa-logging/src/events/control-plane.ts`
- `apps/authorization/src/logging.ts`
- `apps/provisioner/src/logging.ts`
- `apps/resource-docs-api/src/logging.ts`
- `apps/resource-finance-api/src/logging.ts`
- `apps/agent-runtime/src/logging.ts`
- `packages/xaa-logging/test/events-control-plane.spec.ts`

**実装方針**
- イベント名は `authz_ai.infer` / `policy.decide` / `provisioner.provision` / `resource_api.access` / `runtime.tool_call` の5つとする。
- Authorization AI Agent は `agent_draft_id`、`work_definition_id`、`work_definition_hash`（SHA-256 の hex 全長）、`proposed_capabilities`（Capability ID の配列）、`confidence`、`taxonomy_version`、`model_version` を出す。Work Definition の本文フィールドを受け取る引数を関数シグネチャに持たせない。
- Policy Engine は `proposed_capabilities`、`effective_capabilities`、`security_profile`、`isolation_level`、`decision`（`ALLOW` / `DENY`）、`policy_id`、`decision_reason`（Policy 定義に書かれた固定文字列の ID であり自由文でない）を出す。
- Agent Provisioner は `isolation_level`、`dedicated_op`（STANDARD なら `null`）、`provisioned_tools`、`static_xaa`（`audience` と `resource` と `scope` の3キーを持つオブジェクト）、`idp_connection_state`、`connector_state`、`created_at`、`expires_at`、`destroyed_at` を出す。
- Resource API は `tool_id`、`operation`、`http_method`、`resource`、`response_status`、`outcome`、`latency_ms` の7項目を必ず出す。specs 5.1 の「7項目を必須で出す」に一致させる。
- Agent Runtime は `task_id`、`execution_id`、`tool_id`、`requested_operation`、`target_resource`、`result`、`agent_age_seconds`、`expires_at`、`span_id` を出す。`agent_age_seconds` は Runtime が Agent Registration の `created_at` から計算し、Cloud Run のコンテナ起動時刻から計算しない。
- `work_definition_hash` の計算関数は `packages/xaa-contracts/src/work-definition.ts` の1か所に置き、Authorization と Security Detection の双方がそれを import する。

**完了条件**
- [x] `test/events-control-plane.spec.ts::authz ai event has no free text field` が `authz_ai.infer` の必須フィールド配列に本文相当のキーが含まれないことを検査する。
- [x] `apps/resource-docs-api/test/logging.spec.ts::emits seven access fields` が7項目すべての存在を検査する。
- [x] `apps/agent-runtime/test/logging.spec.ts::agent age comes from registration created_at` が、コンテナ起動から10秒後でも Registration の `created_at` が1時間前なら `agent_age_seconds` が 3600 前後になることを検査する。
- [x] 同一の Work Definition 本文から2回計算した `work_definition_hash` が一致することを `packages/xaa-contracts/test/work-definition.spec.ts::hash is deterministic` が検査する。

---

### T-SEC-07 Log Sink と BigQuery 監査テーブルを Terraform で定義する

**概要**
Cloud Logging へ出たログを BigQuery の `security_audit` dataset へ流し込む Log Sink を作る。
dataset と IAM は shared state に置き、Platform 側の Service Account に削除権限を与えない（RULE-42、DEC-IAC-11）。
DEC-SEC-01 の第1段のうち、保存側の土台にあたる。

**対象要件** REQ-01-025
**前提タスク** T-SEC-01
**成果物**
- `infra/envs/shared/audit.tf`
- `infra/envs/shared/audit-tables.tf`
- `infra/envs/shared/schemas/normalized_events.json`
- `infra/envs/shared/schemas/findings.json`
- `infra/envs/shared/schemas/rule_hits.json`
- `infra/envs/shared/schemas/id_jag_ledger.json`
- `infra/tests/audit-iam.test.ts`

**実装方針**
- `google_bigquery_dataset "security_audit"` を location `asia-northeast1`、`default_table_expiration_ms` を30日相当（2592000000）で作る。`delete_contents_on_destroy` を `false` にする。
- Log Sink は `google_logging_project_sink "audit_to_bq"` の1本。フィルタは `jsonPayload.log_source != "" AND resource.type = "cloud_run_revision"` とし、`unique_writer_identity = true`、`bigquery_options { use_partitioned_tables = true }` を付ける。
- Sink の writer identity にだけ `roles/bigquery.dataEditor` を与える。付与は `google_bigquery_dataset_iam_binding`（authoritative）1本にまとめ、`google_bigquery_dataset_iam_member` を使わない。members は sink writer と `sa-security-detection` の2つに限る。
- `sa-security-detection` へ与えるのは `roles/bigquery.dataViewer` と `roles/bigquery.jobUser` と、`findings` / `rule_hits` / `normalized_events` の3テーブルに対する `roles/bigquery.dataEditor`（テーブル単位の `google_bigquery_table_iam_binding`）に限る。dataset 単位の `dataEditor` を security-detection へ与えない。
- テーブル4本を `google_bigquery_table` で作る。`normalized_events`、`findings`、`rule_hits`、`id_jag_ledger`。スキーマは `schemas/*.json` を `file()` で読む。`time_partitioning { type = "DAY", field = "occurred_at" }` を全テーブルに付ける。
- Sink の宛先テーブル（`run_googleapis_com_stdout`）は Log Sink が自動作成するものを使い、Terraform で定義しない。
- `roles/bigquery.admin` と `roles/bigquery.dataOwner` を Platform 側 SA へ付与する記述を書かない。`infra/tests/forbidden-roles.sh` の禁止ロール一覧にこの2つを追加する。

**完了条件**
- [~] `terraform -chdir=infra/envs/shared plan` が差分なしで終わる状態まで apply できる。（デプロイ後に `scripts/deploy-gcp-guide.sh` の verify 段が観測する）
- [x] `bash infra/tests/audit-iam.sh` が、platform 側 SA が `security_audit` に対して削除可能なロールを持たないことを検査して0で終了する。
- [~] `bash infra/tests/forbidden-roles.sh` が `roles/bigquery.admin` と `roles/bigquery.dataOwner` の不在を検査して0で終了する。（デプロイ後に `infra/tests/forbidden-roles.sh` が観測する）
- [x] `grep -c 'google_bigquery_dataset_iam_member' infra/envs/shared/*.tf` が0を返す。

---

### T-SEC-08 security-events トピックへの一方向送信経路を作る

**概要**
Log Sink から Pub/Sub トピック `security-events` へ流し、Security Detection がそれを購読する経路を作る。
Security Detection から各アプリへ戻る同期呼び出しを1本も作らない（REQ-01-025）。
送信元は REQ-01-025 の8アプリに加え、REQ-09-023 が Resource AS 起点の突合を要求するため Resource AS と Resource API の4デプロイ単位を含めた12単位とする。

**対象要件** REQ-01-025
**前提タスク** T-SEC-07
**成果物**
- `infra/envs/demo/security-events.tf`
- `infra/envs/demo/variables.tf`（`security_events_delivery` を追加）
- `apps/security-detection/src/ingest/subscriber.ts`
- `apps/security-detection/src/index.ts`
- `apps/security-detection/test/subscriber.spec.ts`
- `e2e/test/security-events-fanin.spec.ts`

**実装方針**
- `google_pubsub_topic "security_events"` と `google_logging_project_sink "security_events_sink"` を作る。sink のフィルタは T-SEC-07 と同じ条件に `AND severity >= "INFO"` を加える。
- 変数 `security_events_delivery` を `pull`（既定）と `push` の2値にする。Security Detection は `ingress = INTERNAL_ONLY` であり、Pub/Sub push が届くかは DEC-SCOPE-02 の spike (a) の結果に依存するため、既定を pull にする。spike が push 可を示した場合のみ `push` を選べるようにし、`push` のとき `google_pubsub_subscription` に `push_config` と OIDC token を設定する。
- pull の実装は `subscriber.ts` の `startPullLoop(client, subscriptionName, handler)`。`@google-cloud/pubsub` の `subscription.on('message')` を使い、`ack` は handler が正常終了した後に呼ぶ。例外時は `nack` して再配信に任せる。
- `PUBSUB_MODE=inproc` のとき `subscriber.ts` は Pub/Sub クライアントを生成せず、`packages/xaa-contracts` の in-process バスから同じ handler へ配線する。integration テストはこの経路を使う（DEC-APP-07）。
- Security Detection の Hono アプリに、他アプリを呼ぶ HTTP クライアントの生成を書かない。`apps/security-detection/src/**` に `httpClient(` の出現が Lifecycle Manager 宛の1か所だけであることを CI で検査する。
- Terraform の `locals.invoker_edges` に、いずれかのアプリから `security-detection` へ向かうエッジを追加しない。逆方向（security-detection から lifecycle-manager）だけを追加する。

**完了条件**
- [x] `e2e/test/security-events-fanin.spec.ts::twelve deploy units reach the topic` が12単位それぞれから1件ログを出し、購読側で12件受信することを検査する。
- [x] `infra/envs/demo/locals-invoker.tf` の invoker_edges に、宛先が security-detection のアプリ発エッジが0件であることを `bash infra/tests/security-detection-inbound.sh` が検査して通る。唯一許すのは `["pubsub_push", "security-detection"]` で、これは `security_events_delivery = "push"` のときの Pub/Sub 配送用である。
- [x] `apps/security-detection/test/subscriber.spec.ts::nacks on handler failure` が緑になる。
- [x] `security_events_delivery` の既定値が `pull` であることを `bash infra/tests/variable-defaults.sh` が検査して0で終了する。

---

### T-SEC-09 保存済み SQL 4本を BigQuery View として定義する

**概要**
DEC-SEC-01 が必達とする4本の検知 SQL を BigQuery の View として置き、Rule Engine 実装前に最小の検知系を通す。
4本は `delegation_mismatch`、`signing_key_misuse`、`cross_agent_access`、`dpop_replay` とする。
IaC で管理できることを優先し、SQL ファイルを Terraform の `file()` で読む View として定義する。

**対象要件** REQ-09-023, REQ-09-034, REQ-09-020
**前提タスク** T-SEC-05, T-SEC-06, T-SEC-07
**成果物**
- `infra/envs/shared/sql/delegation_mismatch.sql`
- `infra/envs/shared/sql/signing_key_misuse.sql`
- `infra/envs/shared/sql/cross_agent_access.sql`
- `infra/envs/shared/sql/dpop_replay.sql`
- `infra/envs/shared/audit-views.tf`
- `e2e/test/saved-sql.spec.ts`

**実装方針**
- View 名は `v_delegation_mismatch` / `v_signing_key_misuse` / `v_cross_agent_access` / `v_dpop_replay` の4つ。`google_bigquery_table` の `view { query = file("sql/....sql"), use_legacy_sql = false }` で作る。
- 4本の View はいずれも `occurred_at`、`agent_id`、`human_subject`、`trace_id`、`detection_code`、`detail`（JSON 文字列）の6列を返す。列構成を揃え、後段が `UNION ALL` で1本に束ねられるようにする。
- `delegation_mismatch` は `agent_op.token_exchange` イベントのうち `delegation_match = false` の行を返す。判定は Agent OP が同期で済ませており、SQL 側で再判定しない（DEC-SEC-02）。
- `signing_key_misuse` は `resource_as.redeem` を左表、`id_jag_ledger` を右表にした LEFT JOIN で、`ledger.jti IS NULL` または `received_typ != 'oauth-id-jag+jwt'` の行を返す。JOIN の向きを Resource AS 起点に固定し、Agent OP 起点で書かない。
- `cross_agent_access` は `agent_op.*` のログ行のうち、Dedicated OP に注入された `op_agent_id` と、要求が指す `agent_id` が一致しない行を返す。Dedicated OP は Agent と1対1で作られるため、この2値の不一致がそのまま横方向アクセスを表す。外部の履歴テーブルとの突き合わせを要しない。
- `dpop_replay` は `dpop_result = 'replayed_dpop_proof'` の行に加え、同一 `dpop_jti` が2回以上出現する組を `GROUP BY dpop_jti HAVING COUNT(*) > 1` で拾う。両方を `UNION ALL` する。
- View の中で `SELECT *` を書かない。列を明示する。
- 追加のテーブルを作らない。`op_agent_id` は T-OP-30 の Token Exchange ログが必ず出す項目であり、View はそれだけを読む。

**完了条件**
- [~] `terraform -chdir=infra/envs/shared apply` の後、`bq query --use_legacy_sql=false 'SELECT * FROM security_audit.v_delegation_mismatch LIMIT 1'` が構文エラーなく終了する（4 View すべて）。（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [x] `e2e/test/saved-sql.spec.ts::each view returns the six fixed columns` が5 View（T-SEC-14 の `refresh_token_reuse` を含む）の投影列を読み、列名と順序が一致することを検査する。
- [x] `e2e/test/saved-sql.spec.ts::signing key misuse joins from resource as side` が、台帳に無い jti の受領ログを1件入れると `v_signing_key_misuse` が1行返すことを検査する。
- [x] `grep -n 'SELECT \*' infra/envs/shared/sql/*.sql` が0件を返す。

---

### T-SEC-10 Raw Secret がログに出ないことを E2E で固定する

**概要**
redaction がライブラリ単体で効いていても、アプリが独自の経路でログを出せば漏れる。
E2E 実行後に集めた全ログを走査し、JWT 形式の文字列が1件も無いことを検査する回帰テストを置く。
REQ-08-028 と REQ-09-015 の受入条件に直接対応する。

**対象要件** REQ-09-015, REQ-08-028
**前提タスク** T-SEC-05, T-SEC-06, T-SEC-09
**成果物**
- `e2e/test/logging/no-raw-secret.spec.ts`
- `scripts/collect-logs.ts`
- `.github/workflows/e2e.yml`（ログ収集ステップの追加）

**実装方針**
- `scripts/collect-logs.ts` は `gcloud logging read` を使わず、BigQuery の Sink 先テーブルへ `SELECT TO_JSON_STRING(t) FROM security_audit.run_googleapis_com_stdout AS t WHERE _PARTITIONTIME >= TIMESTAMP(@since)` を発行して1行1 JSON のファイル `e2e/artifacts/logs.jsonl` へ落とす。
- `no-raw-secret.spec.ts` は `logs.jsonl` を1行ずつ読み、3つの検査を行う。(1) `/eyJ[A-Za-z0-9_-]{10,}/` に一致しない。(2) `/-----BEGIN [A-Z ]*PRIVATE KEY-----/` に一致しない。(3) T-SEC-02 の deny list 12キーが値付きで出現しない（値が `[REDACTED]` の場合は許す）。
- 違反行が見つかった場合は、行全体ではなく `app` と `event` と `trace_id` と一致した正規表現名だけをエラーメッセージに出す。テストの失敗出力に秘密情報を載せない。
- integration 層でも同じ検査を回せるよう、検査本体を `e2e/src/scan-secrets.ts` の `scanSecrets(lines: string[]): Violation[]` として切り出し、spec からも integration からも呼ぶ。
- ローカルでは `PUBSUB_MODE=inproc` と `STORE_MODE=emulator` で捕捉した stdout を同じ関数に通す。BigQuery が無い環境でこのテストがスキップされる分岐を作らない。

**完了条件**
- [x] `pnpm test:e2e --grep "no-raw-secret"` が緑で、違反0件を報告する。（実体は `e2e/test/logging/no-raw-secret.spec.ts`）
- [x] 意図的に Raw Access Token をログへ渡す fixture アプリを含めた `e2e/test/logging/no-raw-secret.negative.spec.ts` が違反1件を検出する。
- [x] 失敗時の出力に `eyJ` で始まる文字列が含まれないことを `e2e/test/logging/scan-secrets.spec.ts::error message carries no secret` が検査する。
- [x] CI の e2e ジョブが `scripts/collect-logs.ts` を実行し `e2e/artifacts/logs.jsonl` を成果物として保存する。（実体は `.github/workflows/ci.yml`）

---

### T-SEC-11 Protocol Validation の違反コードとイベント型を定義する

**概要**
docs 09 §5.1 が列挙する違反を `ProtocolViolationCode` として16種の列挙型に固定する。
判定は AI を通さず、要求を受けたアプリがその場で行い、結果だけを Security Detection へ送る（DEC-SEC-02）。
Refresh Token 再利用は16種に含まれないため、別の列挙として並置する。

**対象要件** REQ-09-020
**前提タスク** T-SEC-05, T-SEC-06
**成果物**
- `packages/xaa-contracts/src/protocol-violation.ts`
- `packages/xaa-contracts/schema/protocol-validation-event.schema.json`
- `packages/xaa-contracts/test/protocol-violation-code.spec.ts`

**実装方針**
- `PROTOCOL_VIOLATION_CODES` を16要素の `as const` 配列にする。要素は `invalid_signature` / `expired_token` / `expired_agent` / `audience_mismatch` / `resource_mismatch` / `invalid_scope` / `unknown_issuer` / `invalid_client` / `invalid_id_jag` / `invalid_dpop_proof` / `replayed_dpop_proof` / `dpop_key_binding_mismatch` / `human_subject_mismatch` / `unauthorized_tool` / `expired_bridge_connection` / `expired_idp_connection` の順で並べる。
- `EXTENDED_VALIDATION_CODES` を `['refresh_token_reuse'] as const` として別に置く。`ProtocolValidationEvent.code` の型は `ProtocolViolationCode | ExtendedValidationCode` にする。16種固定の検査は `PROTOCOL_VIOLATION_CODES` に対してのみ行う。
- `ProtocolValidationEvent` の必須フィールドは `code`、`outcome`（`pass` / `fail`）、`validation_name`、`human_subject`、`agent_id`、`occurred_at`、`path`（検証が起きた経路の識別子）、`trace_id` の8つ。Raw Token と Private Key を持てるフィールドを型に置かない。
- スキーマは `additionalProperties: false` にし、`access_token` や `dpop_proof` というキーを持つイベントは Ajv 検証で落ちるようにする。
- `emitProtocolValidation(logger, ctx, ev)` を `packages/xaa-contracts/src/protocol-violation.ts` に置き、内部で `logger.warning('protocol_validation', ctx, ev)` を呼ぶ。各アプリはこの1関数だけを使い、独自のイベント名を作らない。
- コードの追加や削除を行う分岐、および文字列を動的に組み立てて `code` に入れる実装を書かない。

**完了条件**
- [x] `packages/xaa-contracts/test/protocol-violation-code.spec.ts::has exactly sixteen codes` が長さ16と全要素の一致を検査する。
- [x] `::event schema rejects raw token fields` が `access_token` キーを持つイベントで Ajv 検証が失敗することを検査する。
- [x] `::refresh token reuse is not in the sixteen` が `refresh_token_reuse` が `PROTOCOL_VIOLATION_CODES` に含まれないことを検査する。
- [x] `grep -rn "protocol_validation" apps/ | grep -v emitProtocolValidation` が0件を返す。

---

### T-SEC-12 Control Plane 側8検証の Protocol Validation 送出を実装する

**概要**
REQ-05-014 から REQ-05-021 に対応する8種の検証（invalid signature、expired token、audience mismatch、invalid scope、invalid DPoP proof、replayed DPoP proof、DPoP key binding mismatch、human_subject mismatch）の成否を、Control Plane 側の保護ミドルウェアから送出する。
送るのは検証名と `human_subject` と `agent_id` と時刻と経路であり、Raw Token と Private Key は送らない。
判定ロジックそのものは Identity 領域のミドルウェアが持ち、この領域は送出点の配置とペイロードの形を決める。

**対象要件** REQ-05-022
**前提タスク** T-SEC-11
**成果物**
- `packages/xaa-contracts/src/validation-hooks.ts`
- `apps/automation-app/src/middleware/protect.ts`（送出の差し込み）
- `apps/authorization/src/middleware/protect.ts`
- `apps/provisioner/src/middleware/protect.ts`
- `apps/lifecycle/src/middleware/protect.ts`
- `packages/xaa-contracts/test/validation-hooks.spec.ts`

**実装方針**
- `validation-hooks.ts` に `VALIDATION_NAME_TO_CODE` マップを置く。キーは `invalid signature` / `expired token` / `audience mismatch` / `invalid scope` / `invalid DPoP proof` / `replayed DPoP proof` / `DPoP key binding mismatch` / `human_subject mismatch` の8つ、値は対応する `ProtocolViolationCode` とする。
- 保護ミドルウェアの検証順序は DEC-ID-12 と DEC-ID-18 に従い、署名 → `typ`（`at+jwt` 以外は 401）→ `exp` → `aud`（DEV-12 の要素一致）→ `scope` → DPoP Proof（署名、`typ`、`htm`、`htu`、`iat` 窓、`jti` 重複、`ath` 一致）→ `cnf.jkt` 一致 → `human_subject` 一致 の固定順とする。
- 最初に失敗した検証だけを `outcome: 'fail'` で送り、後続の検証を実行しない。成功した検証は個別に送らず、全通過時に `code: 'invalid_signature'` ではなく `outcome: 'pass'` かつ `validation_name: 'all'` の1件を送る。イベント数が要求数に比例して膨らまないようにする。
- `path` には `<app>:<method> <route-template>` を入れる。実 URL とクエリ文字列を入れない。
- `human_subject` は Access Token の `sub` から取る（RULE-43）。リクエストボディの値を使う分岐を書かない。
- 送出は同期で行い、送出の失敗が本来の 401 や 403 応答を変えないようにする。送出の例外は握って `logger.error` に落とす。

**完了条件**
- [x] `packages/xaa-contracts/test/validation-hooks.spec.ts::maps eight validation names to codes` が8件の対応を検査する。
- [x] `apps/authorization/test/protect.spec.ts::emits only the first failing validation` が、署名と audience の両方を壊した要求で送出イベントが1件かつ `invalid_signature` であることを検査する。
- [x] `apps/authorization/test/protect.spec.ts::event has no raw token` が送出ペイロードに `access_token` と `dpop_proof` の生文字列が含まれないことを検査する。
- [x] 8種の違反を1つずつ再現する `e2e/test/security/protocol-validation-cp.spec.ts` が、対応するコードのイベントを1件ずつ観測する。

---

### T-SEC-13 Agent OP の10ステップ検証順序と送出を固定する

**概要**
Agent OP の `/xaa/token` は docs 05 §6.3 の10ステップを表の順序どおりに評価し、最初に失敗したステップのエラーコードを返す。
各ステップの成否を Protocol Validation として送出する。
DEC-ID-06 が定めたステップ関数の並びと1対1で対応させ、順序が変わったらテストで落ちるようにする。

**対象要件** REQ-05-075
**前提タスク** T-SEC-11, T-SEC-12
**成果物**
- `apps/agent-op/src/routes/xaa-token.ts`（送出点の追加）
- `apps/agent-op/src/validation-steps.ts`
- `apps/agent-op/test/step-order.spec.ts`
- `apps/agent-op/test/protocol-validation.spec.ts`

**実装方針**
- `validation-steps.ts` に `STEP_ORDER` を10要素の `as const` 配列で置く。要素は DEC-ID-06 の並びに対応させ、`client_assertion` / `parse_params` / `resolve_subject` / `resolve_actor` / `delegation_match` / `registration_status` / `audience` / `scope` / `resource` / `expiry_cap` の10個とする。
- 各ステップの失敗時に返すエラーコードを `STEP_ERROR_CODE` マップで固定する。`client_assertion` は `invalid_client`、`resolve_subject` と `resolve_actor` と `delegation_match` と `registration_status` は `invalid_grant`、`audience` と `resource` は `invalid_target`、`scope` は `invalid_scope`、`expiry_cap` は `invalid_grant` とする。
- Protocol Validation の `code` へは `STEP_TO_VIOLATION` で写像する。`client_assertion` は `invalid_client`、`delegation_match` は `human_subject_mismatch`、`registration_status` は `expired_agent`、`audience` は `audience_mismatch`、`resource` は `resource_mismatch`、`scope` は `invalid_scope`、DPoP 検証は `invalid_dpop_proof` と `replayed_dpop_proof` と `dpop_key_binding_mismatch` を経路に応じて使い分ける。
- 実装は `for (const step of STEP_ORDER)` の1ループにし、ステップ関数を直接並べた分岐を書かない。ループ内で失敗を検出したら `break` し、以降のステップを実行しない。
- 各ステップは `(ctx) => StepResult` の同じシグネチャに揃える。`StepResult` は `{ ok: true } | { ok: false; code: string }`。
- `client_assertion` と `subject_token` の両方を壊した要求で `invalid_client` が返ることを固定する。順序を入れ替えた実装ではこのテストが落ちる。

**完了条件**
- [x] `apps/agent-op/test/step-order.spec.ts::calls steps in fixed order` が spy で10ステップの呼び出し順を検査する。
- [x] `apps/agent-op/test/step-order.spec.ts::returns invalid_client when client auth and subject token both broken` が緑になる。
- [x] `apps/agent-op/test/protocol-validation.spec.ts::emits one event per failing step` が、外から壊せるステップ（`authorize_client` / `parse_params` / `resolve_subject` / `resolve_actor` / `validate_audience` / `validate_scope` / `validate_resource`）をそれぞれ1つずつ壊し、対応するエラーコードの記録が1件ずつ出ることを検査する。
- [x] 送出イベントに `subject_token` と `actor_token` と `client_assertion` の生文字列が含まれないことを `::event carries no raw assertion` が検査する。（実体は `apps/agent-op/test/protocol-validation.spec.ts`）

---

### T-SEC-14 Refresh Token 再利用検知を Protocol Validation として送る

**概要**
Human IdP Connection の Refresh Token は Agent OP だけが保持するため、同じトークンが2回使われたことは漏洩の証拠になる（docs 09 §5.1 末尾）。
Agent OP の Refresh Token Rotation に再利用検知を入れ、`refresh_token_reuse` を Protocol Validation として送る。
16種の列挙は変えず、T-SEC-11 で並置した拡張コードを使う。

**対象要件** REQ-09-020
**前提タスク** T-SEC-11, T-SEC-13
**成果物**
- `apps/agent-op/src/idp-connection/rotation.ts`
- `apps/agent-op/test/refresh-reuse.spec.ts`
- `infra/envs/shared/sql/refresh_token_reuse.sql`
- `infra/envs/shared/audit-views.tf`（View の追加）

**実装方針**
- `idp_connections/{idp_connection_id}` に `refresh_token_generation`（整数）と `refresh_token_fingerprint`（T-SEC-03 の16文字）を持たせる。Rotation のたびに generation を1つ進め、旧 fingerprint を `used_fingerprints` の配列（直近8件まで）へ積む。
- Rotation の入口で、提示された Refresh Token の fingerprint が `used_fingerprints` に含まれるかを Firestore の `runTransaction` 内で判定する。含まれる場合は Rotation を行わず、`emitProtocolValidation` で `code: 'refresh_token_reuse'`、`outcome: 'fail'` を送り、当該 IdP Connection の `status` を `revoked` に落とす。
- 再利用検知後に新しい Refresh Token を発行する分岐を書かない。検知を warn にとどめて継続する分岐も書かない。
- Human IdP 側で Refresh Token を無効化するため、`/token/revoke` を1回だけ呼ぶ。呼び出しの失敗は `logger.error` に落とし、Firestore 側の `revoked` を巻き戻さない。
- BigQuery View `v_refresh_token_reuse` を追加し、T-SEC-09 の4本と同じ6列構成にする。
- 判定は Agent OP の同期処理であり、Security Detection 側で再判定しない（DEC-SEC-02）。View は保存済みイベントの抽出だけを行う。

**完了条件**
- [x] `apps/agent-op/test/refresh-reuse.spec.ts::second use of same refresh token is rejected` が、同じ Refresh Token での2回目の Rotation が失敗し新トークンが発行されないことを検査する。
- [x] `::marks connection revoked on reuse` が Firestore の `status` が `revoked` になることを検査する。（実体は `apps/agent-op/test/refresh-reuse.spec.ts`）
- [x] `::emits refresh_token_reuse validation event` が送出イベントを1件観測する。（実体は `apps/agent-op/test/refresh-reuse.spec.ts`）
- [~] `bq query --use_legacy_sql=false 'SELECT COUNT(*) FROM security_audit.v_refresh_token_reuse'` が構文エラーなく終了する。（デプロイ後に `infra/tests/verify-all.sh` が観測する）

---

### T-SEC-15 ID-JAG 発行台帳と Resource AS 起点の突合バッチを実装する

**概要**
Agent OP が発行した ID-JAG の `jti` と `kid` と `typ` を台帳へ書き、Resource AS が受領した JWT を起点にその台帳を LEFT JOIN する5分バッチを作る。
突合方向を Resource AS 起点に固定する。侵害された Agent OP は自分の不正な発行を台帳へ書かないためである。
検知結果は単発で CRITICAL 扱いとし、T-SEC-31 で Risk Score へ渡す。

**対象要件** REQ-09-023, REQ-05-034
**前提タスク** T-SEC-05, T-SEC-09
**成果物**
- `apps/agent-op/src/ledger.ts`
- `apps/security-detection/src/batch/signing-key-misuse.ts`
- `apps/security-detection/src/routes/internal-batch.ts`
- `infra/envs/demo/scheduler.tf`
- `apps/security-detection/test/signing-key-misuse.spec.ts`
- `e2e/test/security/signing-key-misuse.spec.ts`

**実装方針**
- `ledger.ts` の `recordIssuance({jti, kid, typ, act_sub, sub, aud, resource, issued_at, expires_at})` は署名の直後、応答の組み立ての前に呼ぶ。書き込み先は Firestore の `id_jag_ledger/{jti}` と、同内容の `logger.info('id_jag.issued', ...)` の2経路にする。BigQuery テーブル `id_jag_ledger` へは Log Sink 経由で入る。
- 台帳書き込みが失敗した場合は ID-JAG を発行しない。`try` で握って発行を続ける分岐を書かない。
- `signing-key-misuse.ts` の `runBatch(now: Date)` は、直近10分の `resource_as.redeem` を左表、`id_jag_ledger` を右表とし、`LEFT JOIN ON received_jti = ledger.jti` で `ledger.jti IS NULL` または `received_typ != 'oauth-id-jag+jwt'` の行を返す。窓を10分にして5分ごとに実行し、境界の取りこぼしを重複で吸収する。同じ `received_jti` を2回検知しないよう、処理済み `jti` を Firestore の `batch_state/signing_key_misuse` に保存して除外する。
- 検知1件につき `rule_hits` へ `detection_code: 'signing_key_misuse'`、`level: 'CRITICAL'` の行を書く。Agent OP のログだけを見て判定する経路をコード上作らない（左表を `agent_op.token_exchange` にできないよう、クエリ文字列を定数化してテストで固定する）。
- 起動は Cloud Scheduler の `google_cloud_scheduler_job "signing_key_misuse"`、`schedule = "*/5 * * * *"`、OIDC トークン付きで `POST /internal/batch/signing-key-misuse` を叩く。呼び出し元 SA は `sa-scheduler` 1つに限る。
- `/internal/batch/*` は `sa-scheduler` 以外からの呼び出しを 403 にする。ミドルウェアで OIDC の `email` を検査する。

**完了条件**
- [x] `apps/security-detection/test/signing-key-misuse.spec.ts::joins from resource as side` が、生成される SQL 文字列の `FROM` 句が `resource_as.redeem` 由来のテーブルであることを検査する。
- [x] `e2e/test/security/signing-key-misuse.spec.ts::unrecorded jti becomes critical finding` が、台帳書き込みを抑止した状態で ID-JAG を Resource AS へ提示し、バッチ実行後に `level=CRITICAL` の行が1件できることを検査する。（実体は `apps/security-detection/test/signing-key-misuse.spec.ts`）
- [x] 同 spec の `::wrong typ becomes critical finding` が `typ` を書き換えた JWT でも1件できることを検査する。
- [x] `::same jti is not detected twice` が同じバッチを2回実行しても行数が増えないことを検査する。
- [x] `apps/agent-op/test/ledger.spec.ts::does not issue when ledger write fails` が緑になる。

---

### T-SEC-16 正規化 Event Schema と10種の変換関数を実装する

**概要**
各アプリ固有のログを共通 Event Schema へ変換する Normalization を実装する。
OCSF 完全準拠にはせず、フィールド名だけを OCSF に寄せる。
docs 09 §2 の10行に対して変換関数を1つずつ用意し、変換後は必ず Schema 検証を通す。

**対象要件** REQ-09-017, REQ-09-003
**前提タスク** T-SEC-05, T-SEC-06
**成果物**
- `apps/security-detection/schema/normalized-event.schema.json`
- `apps/security-detection/src/normalize/index.ts`
- `apps/security-detection/src/normalize/converters/*.ts`（10ファイル）
- `apps/security-detection/test/normalize.spec.ts`
- `apps/security-detection/test/fixtures/logs/*.json`（10件）

**実装方針**
- Schema のトップレベルは `class_uid`（整数）、`activity_id`（整数）、`severity_id`（1から6）、`time`（ISO 8601）、`actor`（`{ actor_type, actor_id, on_behalf_of, human_subject, agent_id }`）、`api`（`{ operation, method, resource, status }`）、`metadata`（`{ correlation_uid, trace_id, request_id, app, log_source }`）、`attributes`（自由な map）の8キーとする。`additionalProperties: false` を `attributes` 以外に適用する。
- `class_uid` は log_source ごとに固定値を割り当てる。`human_idp` から `agent_runtime` まで 6001 から 6010 を順に割り当て、`normalize/class-uid.ts` の1マップに置く。
- 変換関数のシグネチャを `(entry: LogEntry) => NormalizedEvent` に揃え、`converters/human-idp.ts` から `converters/agent-runtime.ts` まで10ファイルに1本ずつ置く。`index.ts` は `log_source` をキーにしたレコードで dispatch する。`switch` 文を書かない。
- `metadata.correlation_uid` には `trace_id` を入れる。`trace_id` が空文字の場合は `request_id` を入れ、両方空なら `schema_violation` として弾く。
- `human_subject`、`agent_id`、`trace_id`、`timestamp` のいずれかがキーごと欠けたイベントは変換せず、`schema_violation` として `normalized_events` へは書かずカウンタ `security_detection.schema_violation_total` を1つ増やす。`null` が入っているものは通す。
- `log_source` が10種のいずれでもないイベント（Automation App と Lifecycle Manager が出すもの）は `unmapped_source` として `normalized_events` に `class_uid = 6999` と最小フィールドだけで保存し、以降の段へ渡さない。カウンタ `security_detection.unmapped_source_total` を増やす。
- fixtures は10種それぞれ1件、実アプリの出力をコピーしたものを置く。手書きの理想形にしない。

**完了条件**
- [x] `apps/security-detection/test/normalize.spec.ts::all ten fixtures pass schema validation` が10件すべてで緑になる。（実体は `apps/security-detection/test/fixtures.spec.ts`）
- [x] `::preserves the four common fields` が変換後も `human_subject` と `agent_id` と `trace_id` と `time` が保持されることを検査する。
- [x] `::rejects entry missing agent_id key` が `schema_violation` になり、`null` を入れた入力は通ることを検査する。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::routes unknown log source to unmapped` が `class_uid = 6999` で保存され次段へ渡らないことを検査する。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `ls apps/security-detection/src/normalize/converters/*.ts | wc -l` が10を返す。

---

### T-SEC-17 検知パイプラインの6段を型で固定する

**概要**
Telemetry Collection から Normalization、Protocol Validation、Rule-based Detection、Correlation、Risk Scoring までを、この順序でしか呼べない関数チェーンとして実装する。
各段は前段の出力型だけを入力に取り、段を飛ばす呼び出しが TypeScript の型エラーになるようにする。
REQ-09-001 は blocker であり、以降の Rule と Correlation の実装はすべてこの骨格の上に乗る。

**対象要件** REQ-09-001
**前提タスク** T-SEC-16
**成果物**
- `apps/security-detection/src/pipeline/types.ts`
- `apps/security-detection/src/pipeline/index.ts`
- `apps/security-detection/test/pipeline.spec.ts`
- `apps/security-detection/test/type-fixtures/skip-stage.ts`
- `apps/security-detection/test/type-fixtures/tsconfig.json`

**実装方針**
- 段ごとに branded type を定義する。`RawLogBatch`、`NormalizedBatch`、`ValidatedBatch`、`RuleHitBatch`、`CorrelatedBatch`、`ScoredBatch` の6つ。各型に `readonly __stage: 'raw' | 'normalized' | ...` の phantom フィールドを持たせ、構造的に互換にならないようにする。
- 関数は `collect(input): RawLogBatch`、`normalize(b: RawLogBatch): NormalizedBatch`、`validateProtocol(b: NormalizedBatch): ValidatedBatch`、`detectRules(b: ValidatedBatch): RuleHitBatch`、`correlate(b: RuleHitBatch): CorrelatedBatch`、`score(b: CorrelatedBatch): ScoredBatch` の6本。
- `runPipeline(input)` はこの6本を宣言順に呼ぶだけにする。条件分岐で段を飛ばす記述を置かない。
- `score` の後の分岐は `ScoredBatch` を入力に取る `dispatch(b: ScoredBatch)` に置く。`level === 'LOW'` は `normalized_events` への保存とカウンタ更新だけを行い、`MEDIUM` 以上は Finding を生成して次段へ渡す。境界は 29 と 30 とする。
- 型エラーを検査する fixture として `type-fixtures/skip-stage.ts` に `correlate(normalize(collect(x)))` を書き、`type-fixtures/tsconfig.json` で `tsc --noEmit` を走らせて非ゼロ終了することをテストで確認する。fixture はビルド対象から除外する。
- 各段の呼び出しを spy できるよう、`runPipeline` は依存関数をオブジェクト引数で受け取る形にする。グローバル import を直接呼ばない。

**完了条件**
- [x] `apps/security-detection/test/pipeline.spec.ts::calls six stages in declared order` が spy で順序を検査する。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::type fixture fails to compile` が `npx tsc --noEmit -p test/type-fixtures/tsconfig.json` の終了コードが非ゼロであることを検査する。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::score 29 stores only` が Finding が生成されず `normalized_events` へ1件保存されることを検査する。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::score 30 creates finding` が Finding が1件生成されることを検査する。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `pnpm --filter security-detection build` が `type-fixtures` を含まずに成功する。

---

### T-SEC-18 Raw Log を Security AI へ渡せない lint ルールを追加する

**概要**
Vertex AI を呼ぶモジュールを1ファイルに閉じ込め、そのファイルが正規化ログの型を import できないようにする。
型で防げない「うっかり生ログを渡す」経路を lint で塞ぐ。
RULE-39 の「Raw Log をそのまま全部 AI へ投入しない」をビルド時に固定する。

**対象要件** REQ-09-002
**前提タスク** T-SEC-17
**成果物**
- `apps/security-detection/src/ai/vertex-client.ts`
- `apps/security-detection/eslint.config.js`
- `apps/security-detection/test/lint/no-raw-log-to-ai.spec.ts`
- `apps/security-detection/test/lint/fixtures/violating-import.ts`

**実装方針**
- Vertex AI クライアントの生成と呼び出しを `src/ai/vertex-client.ts` の1ファイルだけに置く。`@google-cloud/vertexai` の import が他ファイルに現れないことも同じ lint 設定で禁止する。
- `eslint.config.js` に `files: ['src/ai/vertex-client.ts']` のブロックを作り、`no-restricted-imports` の `patterns` に `../normalize/*`、`../pipeline/types`、`../normalize`、`@xaa/logging` の4つを指定する。
- `vertex-client.ts` の公開関数は `analyze(input: SecurityAiInput): Promise<unknown>` の1本のみとする。引数の型を `unknown` や `object` にしない。文字列を直接受け取る overload を作らない。
- 逆方向として、`src/normalize/**` と `src/pipeline/**` から `src/ai/**` を import することも `no-restricted-imports` で禁止する。呼び出しは `dispatch` から一方向に行う。
- lint テストは ESLint を Node API（`ESLint` クラス）で起動し、`test/lint/fixtures/violating-import.ts` に対して `errorCount >= 1` を期待値とする。fixture は `src` の外に置き、本体のビルドとテスト実行の対象から外す。

**完了条件**
- [x] `pnpm --filter security-detection lint` が緑になる。
- [x] `apps/security-detection/test/lint/no-raw-log-to-ai.spec.ts::violating fixture reports at least one error` が緑になる。
- [x] `grep -rn "@google-cloud/vertexai" apps/security-detection/src | grep -v "ai/vertex-client.ts"` が0件を返す。
- [x] `analyze` の引数型が `SecurityAiInput` であることを `apps/security-detection/test/ai-input.spec.ts::analyze accepts only SecurityAiInput` が型テストで検査する。

---

### T-SEC-19 Rule Hit の型と閾値ファイル、Token 分類を実装する

**概要**
Rule-based Detection の共通の器（`RuleHit` 型、閾値ファイル、10分窓の集計）を作り、最初の分類として Token を実装する。
Token 要求数、ID-JAG 発行数、Google Token Refresh 失敗数、`subject_token` 再取得数、認証失敗数の5指標を Agent 単位で集計する。
閾値は Agent Baseline の Expected Rate 上限に対する倍率で判定し、倍率はファイルへ外出しする。

**対象要件** REQ-09-030
**前提タスク** T-SEC-17
**成果物**
- `apps/security-detection/src/rules/types.ts`
- `apps/security-detection/src/rules/window.ts`
- `apps/security-detection/src/rules/token.ts`
- `security-rules/thresholds.json`
- `apps/security-detection/test/rules-token.spec.ts`

**実装方針**
- `RuleHit` 型の必須フィールドは `rule_id`、`category`（`token` / `authorization` / `tool` / `lifetime` / `isolation` / `authorization_ai`）、`level`（`MEDIUM` / `HIGH`）、`agent_id`、`human_subject`、`occurred_at`、`trace_id`、`related_events`（イベント ID の配列）、`detail`（map）の9つ。
- `window.ts` の `groupByWindow(events, minutes, keyFn)` は 10 分の固定窓を返す。スライディング窓にしない。窓の境界は `Math.floor(epochMs / 600000)` で決める。
- `thresholds.json` の構造は `{ "token": { "medium_multiplier": 5, "high_multiplier": 20, "metrics": ["token_request", "id_jag_issued", "google_refresh_failure", "subject_token_refetch", "auth_failure"] }, ... }`。倍率をコードへ埋め込まない。
- Token 分類の判定は、指標ごとに `count > baseline.expectedRate[metric].max * high_multiplier` なら HIGH、`count > max * medium_multiplier` なら MEDIUM、それ以外は Hit なしとする。境界は「超えたら」であり、ちょうど等しい値では Hit を出さない。
- Baseline が未生成の Agent（Provisioning 直後など）は Hit を出さず、カウンタ `security_detection.baseline_missing_total` を増やす。既定値で代用する分岐を書かない。
- `rule_id` は `token.<metric>.<level>` の形で組み立てる。自由文にしない。

**完了条件**
- [x] `apps/security-detection/test/rules-token.spec.ts::medium at 100 with max 20` と `::high at 400 with max 20` と `::no hit at 99` が緑になる。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::covers five metrics` が5指標すべてに対して上記3ケースを持つことを、テーブル駆動テストの件数15で検査する。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::no hit when baseline missing` が Hit 0件かつカウンタが1増えることを検査する。
- [x] `security-rules/thresholds.json` の `token.metrics` が5要素であることを `::thresholds file lists five token metrics` が検査する。（実体は `apps/security-detection/test/detection.spec.ts`）

---

### T-SEC-20 Rule-based Detection の Authorization 分類を実装する

**概要**
10分窓で HTTP 401 と 403 の件数、Effective Capability に対応しない scope 要求、静的 XAA 設定に無い audience または resource の要求を Rule Hit にする。
件数閾値のものと1件で Hit するものを分けて実装する。
Runtime 侵害と Agent OP 設定改竄の兆候を拾う分類にあたる。

**対象要件** REQ-09-031
**前提タスク** T-SEC-19
**成果物**
- `apps/security-detection/src/rules/authorization.ts`
- `security-rules/thresholds.json`（`authorization` セクションの追加）
- `apps/security-detection/test/rules-authorization.spec.ts`

**実装方針**
- 条件(1)は `api.status` が 401 または 403 の正規化イベントを Agent 単位で数える。20 超で MEDIUM、100 超で HIGH。閾値は `thresholds.json` の `authorization.status_error.medium` と `.high` に置く。
- 条件(2)は Token Exchange と Resource AS のログに現れた `requested_scope` を分解し、Agent Baseline の `effective_capabilities` から `packages/xaa-contracts` の `CAPABILITY_TO_SCOPE` で導いた集合に含まれない要素があれば1件で MEDIUM。写像表は DEC-SCOPE-03 の確定表を使い、この場所に別名を作らない。
- 条件(3)は `requested_audience` と `requested_resource` を Agent Registration の静的 XAA 設定（`static_xaa.audience` と `.resource`）と突き合わせ、一致しないものがあれば1件で MEDIUM。比較は文字列のバイト一致で行い、接頭辞一致と部分一致を使わない（DEV-12 と同じ方針）。
- (2)(3) は件数によらず1件で Hit を出す。件数で閾値を掛ける分岐を書かない。
- `detail` には `observed` と `expected` の2キーを入れる。`expected` は Baseline と Registration から取った値の配列とする。

**完了条件**
- [x] `apps/security-detection/test/rules-authorization.spec.ts::status errors 20 no hit, 21 medium, 101 high` が緑になる。
- [x] `::unmapped scope hits medium with a single event` が緑になる。
- [x] `::unknown audience hits medium with a single event` と `::unknown resource hits medium with a single event` が緑になる。
- [x] `::audience comparison is exact` が、`https://resource-docs-as-x.run.app` の登録に対し `https://resource-docs-as-x.run.app.evil` が Hit することを検査する。

---

### T-SEC-21 Rule-based Detection の Tool 分類を実装する

**概要**
Tool Catalog に存在しない Tool ID の利用、Provisioning されていない Tool の実行要求、Expected Resources に無い Resource へのアクセスを Rule Hit にする。
2つ目は Protocol Validation の `unauthorized_tool` と `trace_id` で結び付ける。
Tool Executor が同期で止めた事象を、中央でも1件として記録する。

**対象要件** REQ-09-032
**前提タスク** T-SEC-19
**成果物**
- `apps/security-detection/src/rules/tool.ts`
- `apps/security-detection/test/rules-tool.spec.ts`

**実装方針**
- Tool Catalog の一覧は `packages/xaa-contracts` の `TOOL_IDS` 定数（DEC-SCOPE-03 の7件）から取る。Firestore の `catalog/tools` を毎回読む実装にしない。
- 条件(1)は `runtime.tool_call` の `tool_id` が `TOOL_IDS` に含まれない場合。1件で MEDIUM。
- 条件(2)は `tool_id` が `TOOL_IDS` には含まれるが Agent Baseline の `expected_tools` に含まれない場合。1件で MEDIUM。同一 `trace_id` を持つ `protocol_validation` イベントで `code === 'unauthorized_tool'` のものを `related_events` へ入れる。該当が無ければ `related_events` は空配列とし、Hit の生成自体は行う。
- 条件(3)は `resource_api.access` の `resource` が Baseline の `expected_resources` に含まれない場合。1件で MEDIUM。
- 3条件は独立に評価し、同一イベントが2条件に当たった場合は Hit を2件出す。まとめる処理は Correlation 段（T-SEC-27）に任せる。
- `rule_id` は `tool.unknown_tool` / `tool.not_provisioned` / `tool.unexpected_resource` の3つに固定する。

**完了条件**
- [x] `apps/security-detection/test/rules-tool.spec.ts::unknown tool id hits medium` が緑になる。
- [x] `::not provisioned tool links unauthorized_tool by trace_id` が `related_events` に該当の Protocol Validation イベントが1件入ることを検査する。
- [x] `::not provisioned tool still hits when no matching validation event` が `related_events` が空配列で Hit 1件になることを検査する。
- [x] `::unexpected resource hits medium` が緑になる。

---

### T-SEC-22 Rule-based Detection の Lifetime 分類を実装する

**概要**
Agent Age が上限を超えた状態でのイベントと、`expires_at` 経過後のアクセス要求を Rule Hit にする。
判定には Agent Runtime が出す `agent_age_seconds` と `expires_at` を使い、Cloud Run の timeout に依存しない。
DEC-IAC-16 の `agent_max_lifetime_seconds` を上限の唯一の出どころにする。

**対象要件** REQ-09-033
**前提タスク** T-SEC-19
**成果物**
- `apps/security-detection/src/rules/lifetime.ts`
- `apps/security-detection/test/rules-lifetime.spec.ts`
- `e2e/test/lifetime/expired-access.spec.ts`

**実装方針**
- 上限は環境変数 `AGENT_MAX_LIFETIME_SECONDS` から読む。Terraform の `agent_max_lifetime_seconds`（既定 86400、検証プロファイル 3600）が唯一の出どころで、コードに 86400 をリテラルで書かない。
- 条件(1)は `attributes.agent_age_seconds > AGENT_MAX_LIFETIME_SECONDS` のイベント。1件で HIGH。
- 条件(2)は `time > attributes.expires_at` のイベント。1件で HIGH。比較は両方を epoch ミリ秒へ直してから行う。
- `agent_age_seconds` または `expires_at` が欠けたイベントは Hit を出さず、`schema_violation` にもしない（Runtime 以外のログ源には元から無いため）。対象を `log_source === 'agent_runtime'` と `log_source === 'resource_api'` に限定する。
- Cloud Run のリビジョン開始時刻やコンテナのアップタイムを参照する実装を書かない。
- `rule_id` は `lifetime.age_exceeded` と `lifetime.access_after_expiry` の2つに固定する。

**完了条件**
- [x] `apps/security-detection/test/rules-lifetime.spec.ts::age max plus one second hits high` が上限 3600 に対し 3601 で HIGH、3600 で Hit なしになることを検査する。
- [x] `::access after expires_at hits high` が緑になる。
- [x] `::skips events without age fields` が Hit 0件になることを検査する。
- [x] `e2e/test/lifetime/expired-access.spec.ts::expired agent is denied and rule hit is recorded` が、期限切れ Agent のアクセスが拒否され `rule_hits` に1行増えることを検査する。

---

### T-SEC-23 Rule-based Detection の Isolation 分類を実装する

**概要**
Cross-Agent IdP Access、Dedicated OP の `op_agent_id` と要求の `agent_id` が一致しないアクセス、同一 `actor_token` の `sub` に対する複数 `human_subject` の ID-JAG 発行の3条件を Rule Hit にする。
判定はログ行の中で完結させ、外部の履歴テーブルを引かない。
Isolation は RULE-31 から RULE-33 の中心であり、要件は blocker である。

**対象要件** REQ-09-034
**前提タスク** T-SEC-19, T-SEC-09
**成果物**
- `apps/security-detection/src/rules/isolation.ts`
- `infra/envs/demo/scheduler.tf`（リース書き出しジョブの追加）
- `apps/security-detection/test/rules-isolation.spec.ts`

**実装方針**
- 条件(1)は、あるイベントの `agent_id` に対し `attributes.idp_connection_id` が、Firestore の `agents/{agent_id}.idp_connection_id` と一致しない場合。1件で HIGH。
- 条件(2)は、`attributes.op_agent_id` を持つイベントについて、その値が同じ行の `agent_id` と一致しない場合。1件で HIGH。Dedicated OP は Agent と1対1であるため、時刻による区間判定を要しない。
- 条件(3)は、10分窓の `id_jag.issued` を `act_sub` でグループ化し、その中の `sub` の distinct 件数が2以上なら1件で HIGH。Hit は `act_sub` ごとに1件だけ出す。
- 履歴を書き出すバッチを作らない。判定に要る値はすべてログ行の中にある。
- GCP リソースの作成や更新をこのコードから行わない。読み取りだけにする。
- `rule_id` は `isolation.cross_agent_idp` / `isolation.dedicated_op_mismatch` / `isolation.multi_subject_actor` の3つに固定する。

**完了条件**
- [x] `apps/security-detection/test/rules-isolation.spec.ts::cross agent idp access hits high` が緑になる。
- [x] `::dedicated op mismatch hits high` が、`op_agent_id` が `agent-a` の行に `agent_id` が `agent-b` として現れたとき Hit することを検査する。
- [x] `::same act sub with two subjects hits high once` が、`act.sub` 同一で `sub` が user-A と user-B の発行記録2件を入力して Hit が1件になることを検査する。
- [x] `bash infra/tests/runtime-mutation-scope.sh` が `apps/security-detection/src` に GCP リソース変更 API の呼び出しが無いことを検査して0で終了する。

---

### T-SEC-24 Rule-based Detection の Authorization AI 分類を実装する

**概要**
Authorization AI Agent が Capability Taxonomy に無い Capability を生成した場合、Taxonomy 外の形式（URL や HTTP メソッドや OAuth scope）の文字列を生成した場合、Proposed と Effective の差が Proposed の 50% を超えた場合を Rule Hit にする。
AI の出力を後段で検算する位置づけであり、RULE-09 と RULE-10 に対応する。

**対象要件** REQ-09-035
**前提タスク** T-SEC-19
**成果物**
- `apps/security-detection/src/rules/authorization-ai.ts`
- `apps/security-detection/test/rules-authz-ai.spec.ts`

**実装方針**
- Taxonomy は `packages/xaa-contracts` の `CAPABILITIES` 定数（DEC-SCOPE-03 の8件）を正とする。Firestore から読まない。
- 条件(1)は `attributes.proposed_capabilities` に `CAPABILITIES` に無い要素がある場合。1件で HIGH。
- 条件(2)は要素が Capability ID の形式に合わない場合。形式は `^[a-z]+(\.[a-z_]+){1,2}$` とし、加えて `https://` または `http://` を含むもの、`GET ` `POST ` `PUT ` `PATCH ` `DELETE ` のいずれかで始まるもの、`:` を含むものを Taxonomy 外とみなす。1件で HIGH。条件(1)と(2)の両方に当たる要素については Hit を(2)としてのみ出す。
- 条件(3)は `1 - (effective.length / proposed.length) > 0.5` で MEDIUM。`proposed.length === 0` の場合は Hit を出さず、`schema_violation` にもしない。
- Capability の集合比較は順序に依存させない。`Set` へ入れてから比較する。
- `rule_id` は `authz_ai.unknown_capability` / `authz_ai.out_of_taxonomy_format` / `authz_ai.large_gap` の3つに固定する。

**完了条件**
- [x] `apps/security-detection/test/rules-authz-ai.spec.ts::unknown capability hits high` が緑になる。
- [x] `::url form hits high` と `::http method form hits high` が `https://api.example.com/v1/x` と `GET /v1/documents` の両方で HIGH になることを検査する。
- [x] `::gap 50 percent no hit, 51 percent medium` が境界値を検査する。
- [x] `::empty proposed produces no hit` が緑になる。

---

### T-SEC-25 Agent Baseline を Provisioning 完了時に生成する

**概要**
Agent ごとの Baseline を過去履歴ではなく Agent Definition から導出し、Provisioning 完了時に1度だけ生成する。
最大 Lifetime が短く履歴が貯まらないため、期待値を定義から作る（RULE-40）。
Rule-based Detection の Token 分類と Tool 分類と Baseline 逸脱判定は、すべてこの Baseline を入力にする。

**対象要件** REQ-09-039
**前提タスク** T-SEC-19
**成果物**
- `apps/security-detection/src/baseline/build.ts`
- `apps/security-detection/src/baseline/types.ts`
- `apps/provisioner/src/baseline-hook.ts`
- `apps/security-detection/test/baseline.spec.ts`
- `e2e/test/security/baseline.spec.ts`

**実装方針**
- `AgentBaseline` の6要素は `effective_capabilities`、`expected_tools`、`expected_resources`、`expected_rate`、`lifetime`、`current_session_behavior`。すべて必須にし、optional を作らない。
- `expected_rate` は `{ id_jag: {min, max}, api_request: {min, max} }`。既定は ID-JAG が 2 から 20、API Request が 10 から 100。Tool 数に比例して調整し、`max = base_max * max(1, ceil(expected_tools.length / 2))` とする。この式を `build.ts` の1か所に置く。
- `expected_tools` は Provisioned Tool の `tool_id` 配列をそのまま使う。`expected_resources` は Tool 定義から `resource` を引いて重複を除いた配列にする。
- `lifetime` は Agent Registration の `expires_at` をそのまま入れる。再計算しない。
- `current_session_behavior` は生成時点では全カウンタ 0 の構造体にする。更新は Rule 実行時に `agents/{agent_id}/baseline` へ増分書き込みする。
- 保存先は Firestore の `agents/{agent_id}/baseline`（サブコレクションではなく単一ドキュメント）。書き込みは Provisioner の Provisioning Transaction 完了後に `baseline-hook.ts` から1回だけ呼ぶ。Provisioning が失敗した場合は書かない。
- Baseline を実行中に上書き再生成する経路を作らない。Re-Provisioning（T-LIFE-10）では新しい `agent_id` に対して新規生成する。

**完了条件**
- [x] `apps/security-detection/test/baseline.spec.ts::has all six elements` が6要素すべてが埋まることを検査する。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::expected rate scales with tool count` が Tool 4件のとき API Request の max が 200 になることを検査する。
- [x] `e2e/test/security/baseline.spec.ts::baseline exists right after provisioning` が Provisioning 完了直後に doc が存在することを検査する。
- [x] `::expected tools equal provisioned tools` が集合として一致することを検査する。（実体は `e2e/test/security/baseline.spec.ts`）
- [x] `::not written when provisioning fails` が失敗経路で doc が作られないことを検査する。

---

### T-SEC-26 Baseline 逸脱の6条件を判定する

**概要**
Baseline に対する逸脱を6条件で判定する関数を実装する。
条件は Expected Tools 外の Tool、Effective Capability に対応しない Tool、Expected Resources 外の Resource、Expected Rate 上限の大幅超過、別 Agent の Dedicated OP へのアクセス、`expires_at` 後のアクセスである。
docs 09 §5.4 の「ID-JAG 500 回」は4つ目の具体例として固定テストへ入れる。

**対象要件** REQ-09-040
**前提タスク** T-SEC-25, T-SEC-21, T-SEC-22, T-SEC-23
**成果物**
- `apps/security-detection/src/baseline/deviation.ts`
- `apps/security-detection/test/baseline-deviation.spec.ts`

**実装方針**
- `detectDeviations(baseline: AgentBaseline, batch: ValidatedBatch): Deviation[]` を実装する。`Deviation` は `{ kind, observed, expected, occurred_at, trace_id }` の5フィールド。
- `kind` は `unexpected_tool` / `capability_mismatch` / `unexpected_resource` / `rate_exceeded` / `foreign_dedicated_op_access` / `access_after_expiry` の6値に固定する。
- 判定ロジックは T-SEC-21 から T-SEC-23 の Rule 実装を再利用せず、Baseline を基準にした独立した判定として書く。Rule Hit は閾値超過の警報であり、Deviation は Security AI へ渡す逸脱の記述であるため、出力の型を分ける。
- `rate_exceeded` の閾値は Expected Rate の `max` そのものとし、`thresholds.json` の倍率を掛けない。倍率は Rule 側の役割であることを `deviation.ts` の先頭コメントで明記する。
- `capability_mismatch` は Tool 定義の `required_capability` が `baseline.effective_capabilities` に含まれないかで判定する。Tool ID の一致だけで判定しない。
- 各条件は独立に評価し、1イベントが複数条件に当たれば複数の Deviation を返す。重複排除を行わない。

**完了条件**
- [x] `apps/security-detection/test/baseline-deviation.spec.ts::six kinds have positive and negative cases` が12件のテーブル駆動ケースで緑になる。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::id-jag 500 against max 20 is rate_exceeded` が緑になる。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::capability mismatch detected even when tool id is expected` が、`expected_tools` に含まれるが `required_capability` が Effective に無い Tool で `capability_mismatch` が出ることを検査する。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::one event can yield two deviations` が緑になる。

---

### T-SEC-27 agent_id 単位の Correlation と Finding 生成を実装する

**概要**
同一 `agent_id` の 10 分窓の Rule Hit と Protocol Violation をまとめ、1つの Security Finding にする。
Finding は時系列の `related_events` と寄与コード一覧を持つ。
docs 09 §5.3 の4イベントの例が1件の `potential_agent_compromise` になることを固定テストにする。

**対象要件** REQ-09-036
**前提タスク** T-SEC-19, T-SEC-20, T-SEC-21, T-SEC-22, T-SEC-23, T-SEC-24
**成果物**
- `apps/security-detection/src/correlate/index.ts`
- `apps/security-detection/src/correlate/finding.ts`
- `apps/security-detection/schema/finding.schema.json`
- `apps/security-detection/test/correlation.spec.ts`

**実装方針**
- `SecurityFinding` の必須フィールドは `finding_id`、`finding_type`、`agent_id`、`human_subject`、`window_start`、`window_end`、`related_events`、`contributing_codes`、`risk_score`、`risk_level`、`review_status`、`created_at` の12個。`risk_score` と `risk_level` は T-SEC-29 と T-SEC-30 が埋めるまで `null` を許す。
- `finding_id` は `f_` + `window_start` の epoch 秒 + `_` + `agent_id` の SHA-256 先頭8文字 とする。同じ窓と同じ Agent で2回実行しても同じ ID になり、上書きで冪等になるようにする。ランダム UUID を使わない。
- `related_events` は `occurred_at` の昇順で並べる。同時刻は `trace_id` の辞書順で決める。安定した順序にする。
- `contributing_codes` は Rule Hit の `rule_id` と Protocol Violation の `code` を重複なしで並べた配列とする。出現順ではなく辞書順に固定する。
- `finding_type` の決定は `correlate/finding.ts` の `classify(codes: string[]): FindingType` に閉じる。`authorization.unknown_audience` と `isolation.*` と `token.id_jag_issued.*` と `authorization.status_error.*` のうち3種以上が揃えば `potential_agent_compromise` とする。それ以外は `anomalous_agent_activity` とする。
- 窓に Rule Hit も Protocol Violation も無い Agent については Finding を作らない。空の Finding を作る分岐を書かない。

**完了条件**
- [x] `apps/security-detection/test/correlation.spec.ts::docs example becomes one finding` が docs §5.3 の4イベントを時刻付きで投入し、Finding 1件、`related_events` 4件、`finding_type = 'potential_agent_compromise'` になることを検査する。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::related events are sorted by occurred_at` が緑になる。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::finding id is stable across runs` が同じ入力で2回実行して同じ `finding_id` になることを検査する。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::no finding for empty window` が緑になる。

---

### T-SEC-28 human_subject 単位と全体単位の Correlation を実装する

**概要**
Agent A から Agent B や C の Dedicated OP への横方向アクセスは Agent 単体のログでは見えない。
Correlation を `agent_id` だけで分割せず、`human_subject` 単位と全体単位の窓でも集計する。
同一 `human_subject` の複数 Agent にまたがる Isolation Rule Hit が 10 分窓で2件以上あれば1件の Finding にまとめる。

**対象要件** REQ-09-037
**前提タスク** T-SEC-27
**成果物**
- `apps/security-detection/src/correlate/cross-agent.ts`
- `apps/security-detection/test/correlation-cross-agent.spec.ts`

**実装方針**
- 窓を3つ作る。`byAgent`（T-SEC-27 の既存）、`bySubject`、`global`。3つとも同じ 10 分の固定窓境界を使う。
- `bySubject` の判定は、`category === 'isolation'` の Rule Hit を `human_subject` でまとめ、関与する `agent_id` の distinct 件数が2以上なら `cross_agent_lateral_movement` の Finding を1件作る。
- この Finding が作られた場合、寄与した Isolation Rule Hit を `byAgent` 側の Finding へは含めない。二重計上を避けるため、Correlation の実行順を `bySubject` → `byAgent` → `global` に固定し、消費済みの Hit を `Set<string>`（Hit の ID）で除外する。
- `global` 窓は、同一の `dedicated_short_id` に対して異なる `human_subject` の Isolation Hit が現れた場合に `platform_wide_isolation_breach` を1件作る。件数閾値は2以上とする。
- `finding_id` は T-SEC-27 と同じ規則で作り、キーに `agent_id` の代わりに `human_subject` または `'global'` を使う。
- Agent ごとに Finding を分割して出す実装を残さない。

**完了条件**
- [x] `apps/security-detection/test/correlation-cross-agent.spec.ts::two foreign dedicated op accesses become one cross agent finding` が、Agent A のログに Agent B と Agent C の Dedicated OP へのアクセスが各1件ある入力に対して Finding が2件ではなく1件になることを検査する。
- [x] `::consumed hits do not appear in per agent findings` が緑になる。（実体は `apps/security-detection/test/correlation-cross-agent.spec.ts`）
- [x] `::single isolation hit stays in per agent finding` が1件だけのときは `byAgent` 側に残ることを検査する。（実体は `apps/security-detection/test/correlation-cross-agent.spec.ts`）
- [x] `::correlation runs in fixed order` が spy で `bySubject` → `byAgent` → `global` の順を検査する。

---

### T-SEC-29 Risk Score を13要素から算出する

**概要**
13要素それぞれに加点値を定義し、10分窓で加算して 0 から 100 に clamp する。
加点表はコードへ埋め込まずファイルへ外出しし、要素の欠落をテストで防ぐ。
Resource Sensitivity は金融系 Resource にのみ加点する（specs 5.2 の Risk Policy）。

**対象要件** REQ-09-041
**前提タスク** T-SEC-27
**成果物**
- `security-rules/scoring.json`
- `apps/security-detection/src/score/compute.ts`
- `apps/security-detection/src/score/factors.ts`
- `apps/security-detection/test/scoring.spec.ts`

**実装方針**
- `factors.ts` に `SCORE_FACTORS` を13要素の `as const` 配列で置く。要素は `protocol_violation` / `authorization_violation` / `authorization_ai_anomaly` / `behavior_deviation` / `request_rate` / `resource_sensitivity` / `cross_agent_activity` / `dpop_failure` / `delegation_mismatch` / `signing_key_misuse` / `privilege_escalation_attempt` / `agent_expiration_violation` / `isolation_boundary_violation`。
- `scoring.json` は `{ "<factor>": { "per_event": n, "cap": m } }` の形。`per_event` は1件あたりの加点、`cap` はその要素の窓内上限。読み込み時に Ajv でキー集合が `SCORE_FACTORS` と完全一致することを検証し、過不足があれば起動時に例外を投げる。
- `computeScore(finding: SecurityFinding): number` は、寄与コードを `factors.ts` の `CODE_TO_FACTOR` マップで要素へ写像し、要素ごとに `min(count * per_event, cap)` を求めて総和し、`Math.min(100, total)` を返す。減点や係数の掛け算を入れない。
- `resource_sensitivity` は `api.resource` が finance の Resource URL（Terraform の `platform_endpoints` から注入される `RESOURCE_FINANCE_API_URL`）と一致する場合にのみ加点する。docs 側の Resource には加点しない。
- 乱数と現在時刻を計算に混ぜない。同じ Finding から常に同じ score が出るようにする。
- 写像できないコードは無視せず、`security_detection.unmapped_code_total` を増やしてテストで検出できるようにする。

**完了条件**
- [x] `apps/security-detection/test/scoring.spec.ts::scoring json keys match thirteen factors` が完全一致を検査する。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::total is clamped to 100` が緑になる。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::same input yields same score` が同じ Finding を2回計算して一致することを検査する。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::resource sensitivity applies to finance only` が docs Resource では加点0、finance Resource では加点ありになることを検査する。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::every rule id maps to a factor` が T-SEC-19 から T-SEC-24 で定義した全 `rule_id` が写像を持つことを検査する。

---

### T-SEC-30 Risk Level への写像と LOW 分岐を実装する

**概要**
score を LOW と MEDIUM と HIGH と CRITICAL の4段階へ写像し、LOW は保存と観測にとどめる。
MEDIUM 以上のみ Finding をテーブルへ書き、次段の AI 分析へ渡す。
境界値の扱いを表のとおりに固定する。

**対象要件** REQ-09-042, REQ-09-044
**前提タスク** T-SEC-29, T-SEC-17
**成果物**
- `apps/security-detection/src/score/level.ts`
- `apps/security-detection/src/pipeline/dispatch.ts`
- `apps/security-detection/test/risk-level.spec.ts`
- `e2e/test/security/low-not-escalated.spec.ts`

**実装方針**
- `toLevel(score: number): RiskLevel` は 0 から 29 を LOW、30 から 59 を MEDIUM、60 から 79 を HIGH、80 から 100 を CRITICAL とする。範囲外の入力（負数や 101 以上）は例外を投げる。clamp して受け入れる分岐を書かない。
- `dispatch(b: ScoredBatch)` は LOW について `security_audit.normalized_events` への保存とカウンタ `security_detection.low_events_total` の更新だけを行う。`findings` テーブルへ書かない。Vertex AI クライアントを生成しない。
- MEDIUM 以上は `security_audit.findings` へ1行書き、`analyze()` を呼ぶ。書き込みは `finding_id` を主キーとした `MERGE` で行い、同じ窓の再実行で行が増えないようにする。
- LOW の Finding オブジェクトを作ってから破棄する実装にしない。分岐を level 判定の直後に置き、Finding の構築自体を行わない。
- AI クライアントの生成箇所を `dispatch.ts` の MEDIUM 以上の分岐の内側に限定し、モジュールのトップレベルで生成しない。テストが spy で呼び出し回数を数えられるようにする。

**完了条件**
- [x] `apps/security-detection/test/risk-level.spec.ts::eight boundary points` が 0,29,30,59,60,79,80,100 が LOW,LOW,MEDIUM,MEDIUM,HIGH,HIGH,CRITICAL,CRITICAL になることを検査する。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::throws on out of range` が -1 と 101 で例外になることを検査する。
- [x] `e2e/test/security/low-not-escalated.spec.ts::score 20 creates no finding and no ai call` が `findings` の行数が増えず AI クライアントの spy が0回であることを検査する。
- [x] `::same window twice does not duplicate finding rows` が緑になる。（実体は `e2e/test/security/low-not-escalated.spec.ts`）

---

### T-SEC-31 単発 CRITICAL の2要素を固定する

**概要**
`delegation_mismatch` と `signing_key_misuse` は、他に何の Rule Hit が無くても単独で CRITICAL になる。
前者は委譲されていない Agent として Resource へ届こうとした事象、後者は issuer の署名鍵が用途外で使われた事象だからである。
scoring.json での設定とコード上の不変条件の両方で固定する。

**対象要件** REQ-09-043
**前提タスク** T-SEC-29, T-SEC-30, T-SEC-15
**成果物**
- `security-rules/scoring.json`（該当2要素の値）
- `apps/security-detection/src/score/compute.ts`（不変条件の追加）
- `apps/security-detection/test/critical-singleton.spec.ts`

**実装方針**
- `scoring.json` の `delegation_mismatch` と `signing_key_misuse` を `{ "per_event": 100, "cap": 100 }` にする。
- `computeScore` の末尾に不変条件を置く。寄与コードにこの2要素のいずれかが含まれるなら `return 100` とし、他要素との合成結果に依存させない。設定ファイルの値が誤って下げられても CRITICAL が保たれるようにする。
- 不変条件の対象コードは `CRITICAL_SINGLETON_FACTORS` として `factors.ts` に2要素の配列で置く。3つ目を足す場合はこの配列とテストの両方を変える必要がある形にする。
- `delegation_mismatch` の入力は T-SEC-13 の `human_subject_mismatch` イベントと、T-SEC-09 の `v_delegation_mismatch` View の行の2経路から来る。両方が同じ要素へ写像されることを `CODE_TO_FACTOR` で保証する。
- 例外や設定で CRITICAL を抑止するフラグを作らない。

**完了条件**
- [x] `apps/security-detection/test/critical-singleton.spec.ts::delegation mismatch alone is 100 critical` が緑になる。
- [x] `::signing key misuse alone is 100 critical` が緑になる。（実体は `apps/security-detection/test/critical-singleton.spec.ts`）
- [x] `::stays critical when scoring json lowers the value` が `per_event` を 1 に書き換えた設定でも 100 になることを検査する。（実体は `apps/security-detection/test/critical-singleton.spec.ts`）
- [x] `::critical singleton list has exactly two factors` が緑になる。（実体は `apps/security-detection/test/critical-singleton.spec.ts`）

---

### T-SEC-32 Security AI の入力を要約構造体に固定する

**概要**
Security AI へ渡す入力を `SecurityAiInput` 型に固定し、正規化済み Event の配列や生ログ文字列を渡せないようにする。
Work Definition の本文は載せず、SHA-256 Hash と操作種別の配列に置き換える。
シリアライズ後 8KB を超える場合は Related Events を新しい順に切り詰める。

**対象要件** REQ-09-045, REQ-09-014
**前提タスク** T-SEC-18, T-SEC-27, T-SEC-30
**成果物**
- `apps/security-detection/src/ai/input.ts`
- `apps/security-detection/schema/security-ai-input.schema.json`
- `apps/security-detection/test/ai-input.spec.ts`

**実装方針**
- `SecurityAiInput` の項目は docs 09 §5.6 の列挙どおりの15個とする。`security_finding`、`risk_score`、`related_events_summary`、`agent_baseline`、`agent_definition`、`work_definition_summary`、`proposed_capabilities`、`effective_capabilities`、`allowed_tools`、`isolation_level`、`relevant_authorization_decisions`、`audience`、`resource`、`scope`、`agent_age_seconds`、`time_series`。すべて必須にする。
- `work_definition_summary` は `{ hash: string, operation_kinds: string[] }` の2キーだけにする。本文を入れられるフィールドを型に置かない。`operation_kinds` は Capability Taxonomy 上の識別子の配列とする。
- `related_events_summary` の要素は `{ occurred_at, code, tool_id, resource, status }` の5キーに限る。`attributes` や `detail` の map をそのまま入れない。
- 切り詰めは `JSON.stringify(input)` のバイト長を測り、8192 を超える間 `related_events_summary` の末尾（古い方）から1件ずつ削る。他の項目を削らない。`related_events_summary` が空になっても超える場合は例外を投げ、AI を呼ばずに Rule ベースの Response へフォールバックする。
- `buildAiInput` は `SecurityFinding` と `AgentBaseline` と Agent Registration の3つだけを引数に取る。`NormalizedEvent[]` を引数に取らない（T-SEC-18 の lint がこれを機械的に保証する）。
- 出力を Ajv で検証してから `analyze()` に渡す。検証失敗時は AI を呼ばない。

**完了条件**
- [x] `apps/security-detection/test/ai-input.spec.ts::all fifteen items are populated` が緑になる。
- [x] `::truncates to 8kb with 1000 related events` が出力が 8192 バイト以下、かつ新しいイベントが残ることを検査する。（実体は `apps/security-detection/test/ai-input.spec.ts`）
- [x] `::work definition body never appears` が本文に含めた特徴的な文字列がシリアライズ結果に一切出現しないことを検査する。（実体は `apps/security-detection/test/ai-input.spec.ts`）
- [x] `::throws when still over limit after truncation` が緑になる。（実体は `apps/security-detection/test/ai-input.spec.ts`）

---

### T-SEC-33 Security AI の出力スキーマ4観点とフォールバックを実装する

**概要**
Security AI の出力を「逸脱」「判断」「影響」「推奨」の4観点に固定した JSON Schema で受ける。
パース失敗またはスキーマ不適合の場合は AI 出力を使わず、Rule ベースの Response へフォールバックする。
モデルは Vertex AI の Gemini Flash 系1種に固定し、名前は Terraform 変数から注入する。

**対象要件** REQ-09-046
**前提タスク** T-SEC-32
**成果物**
- `apps/security-detection/schema/security-ai-output.schema.json`
- `apps/security-detection/src/ai/output.ts`
- `apps/security-detection/src/ai/vertex-client.ts`
- `apps/security-detection/test/ai-output.spec.ts`

**実装方針**
- Schema のトップレベルは `deviation`、`judgement`、`impact`、`recommendation` の4キー。`deviation` は `{ from_normal: string, capability_consistency: string }`、`judgement` は `{ compromise_likelihood: string, false_positive_likelihood: string, causality: string }`、`impact` は `{ scope: string, op_propagation: string }`、`recommendation` は `{ response: 'ACTIVE'|'SUSPICIOUS'|'QUARANTINED'|'REVOKED'|'DESTROYED', confidence: number }` とする。`confidence` は `minimum: 0, maximum: 1`。
- モデル名は環境変数 `VERTEX_MODEL` から読む。Terraform 変数 `vertex_model`（既定 `gemini-2.5-flash`）が唯一の出どころで、コードにモデル名をリテラルで書かない（DEC-APP-10）。
- `VERTEX_MODE=fake` のとき `vertex-client.ts` は Vertex AI を呼ばず、`test/fixtures/ai-output/*.json` から決まった応答を返す。integration と e2e はこのモードで回す。
- `parseAiOutput(raw: string): AiOutput | null` は、JSON パース失敗、Ajv 検証失敗、`confidence` の範囲外のいずれでも例外を投げず `null` を返す。呼び出し側は `null` のとき `fallbackResponse(finding)` を使う。
- `fallbackResponse(finding)` は Risk Level だけから Response を決める。CRITICAL は `QUARANTINED`、HIGH は `SUSPICIOUS`、MEDIUM は `ACTIVE`（記録のみ）とする。
- リトライを実装しない。1回呼んで失敗ならフォールバックする。

**完了条件**
- [x] `apps/security-detection/test/ai-output.spec.ts::accepts valid four-aspect output` が緑になる。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::returns null for non json / missing aspect / confidence out of range` が3パターンで `null` を返し例外を投げないことを検査する。（実体は `apps/security-detection/test/detection.spec.ts`）
- [x] `::falls back by risk level` が CRITICAL で `QUARANTINED`、HIGH で `SUSPICIOUS` になることを検査する。
- [x] `grep -rn "gemini" apps/security-detection/src` が0件を返す。

---

### T-SEC-34 Response の状態遷移と Lifecycle Manager への依頼を実装する

**概要**
Finding に応じて Security Detection が Lifecycle Manager へ状態遷移を依頼する。
遷移は ACTIVE から SUSPICIOUS、QUARANTINED、REVOKED、DESTROYED の一方向で、段を戻す遷移を作らない。
docs 09 §6 に対応し、要件 ID の割り当てが無いため DEC-SCOPE-05 に従って起票する。

**対象要件** docs/09-security-monitoring.md §6（対応する REQ なし。DEC-SCOPE-05 により起票）
**前提タスク** T-SEC-33
**成果物**
- `apps/security-detection/src/response/state.ts`
- `apps/security-detection/src/response/dispatch.ts`
- `apps/lifecycle/src/routes/internal-security.ts`
- `apps/security-detection/test/response-state.spec.ts`

**実装方針**
- `AGENT_SECURITY_STATES` を `['ACTIVE','SUSPICIOUS','QUARANTINED','REVOKED','DESTROYED'] as const` で定義する。`canTransition(from, to)` は配列上の index が増える方向のみ `true` を返す。同一状態への遷移は `false` とする。
- 依頼は `POST /internal/security/transition` を Lifecycle Manager へ1回だけ送る。body は `{ agent_id, from, to, finding_id, reason_code }`。`reason_code` は Finding の `finding_type` をそのまま使い、自由文を送らない。
- 認証は DPoP 付きの Access Token（DEC-ID-13 の経路3ではなくサービス間経路のため Cloud Run の run.invoker と OIDC）で行う。`locals.invoker_edges` に `security-detection -> lifecycle` の1エッジだけを追加する。
- Lifecycle Manager 側は QUARANTINED を受けたら Agent OP の新規 ID-JAG 発行と `subject_token` 払い出しを止める（Agent Registration の `status` を `quarantined` にする）。REVOKED 以降は docs 07 §6 の Cleanup を実行する。Cleanup の実装は Lifecycle 領域（T-LIFE-05）が持ち、この領域では呼び出しだけを行う。
- 同じ `finding_id` で2回依頼が届いても状態が二重に進まないよう、Lifecycle Manager 側で `agents/{agent_id}/security_transitions/{finding_id}` を条件付き作成して冪等にする。
- Security Detection から Agent OP や Resource AS を直接呼ばない。すべて Lifecycle Manager 経由にする。

**完了条件**
- [x] `apps/security-detection/test/response-state.spec.ts::forward transitions only` が全 25 組の遷移可否を検査する。
- [x] `apps/lifecycle/test/internal-security.spec.ts::same finding twice advances once` が緑になる。（実体は `apps/lifecycle-manager/test/internal-security.spec.ts`）
- [x] `apps/lifecycle/test/internal-security.spec.ts::quarantine stops id-jag issuance` が、遷移後の `/xaa/token` が `invalid_grant` を返すことを検査する。（実体は `apps/lifecycle-manager/test/internal-security.spec.ts`）
- [x] `grep -rn "httpClient(" apps/security-detection/src` の宛先が `lifecycle` の1か所だけであることを CI ステップが検査する。

---

### T-SEC-35 判断が曖昧な Finding を Human Review へ回す

**概要**
Security AI の confidence が 0.7 未満、または推奨 Response が QUARANTINED 以上の Finding は、Lifecycle Manager への依頼を保留して `review_status='pending'` で保存する。
承認と却下は CLI スクリプトから内部エンドポイントを叩いて行う。
専用 UI は作らない。

**対象要件** REQ-09-050
**前提タスク** T-SEC-34
**成果物**
- `apps/security-detection/src/response/review.ts`
- `apps/security-detection/src/routes/internal-review.ts`
- `scripts/review-finding.ts`
- `e2e/test/security/human-review.spec.ts`

**実装方針**
- 保留の条件は2つの OR。`recommendation.confidence < 0.7`、または `recommendation.response` が `QUARANTINED` / `REVOKED` / `DESTROYED` のいずれか。フォールバック経路（AI 出力が `null`）の場合も保留とする。
- 保留時は `findings` の `review_status` を `pending` にし、`recommended_response` と `confidence` を同じ行へ書く。Lifecycle Manager を呼ばない。
- `POST /internal/review/{finding_id}` は body `{ decision: 'approve' | 'reject', reviewer: string }` を受ける。`approve` のときだけ T-SEC-34 の `dispatch` を1回呼び、`review_status` を `approved` にする。`reject` は呼ばずに `rejected` にする。
- 既に `approved` または `rejected` の Finding への再実行は 409 を返す。状態を上書きしない。
- `scripts/review-finding.ts <finding_id> approve|reject` は引数を2つだけ取り、`gcloud auth print-identity-token` で得た OIDC トークンを付けて上記エンドポイントを叩く。Firestore や BigQuery を直接書き換えない。
- 画面やルートを Automation App に追加しない。

**完了条件**
- [x] `e2e/test/security/human-review.spec.ts::confidence 0.5 stays pending` が Lifecycle Manager の spy が0回であることを検査する。
- [x] `::approve calls lifecycle once` が緑になる。（実体は `e2e/test/security/human-review.spec.ts`）
- [x] `::reject sets rejected and calls nothing` が緑になる。（実体は `e2e/test/security/human-review.spec.ts`）
- [x] `::second decision returns 409` が緑になる。（実体は `e2e/test/security/human-review.spec.ts`）
- [x] `node scripts/checks/code-grep.mjs 'review' apps/automation-app/src` が0件を返す（Automation App に Human Review の画面もルートも作らない）。

---

### T-SEC-36 AGENT_QUARANTINED の Activity Event を発行する

**概要**
Agent を隔離したとき、Security Detection が Activity Event `AGENT_QUARANTINED` を発行する。
`related_finding_id` に Finding ID を入れ、`message` に人間向けの理由文をイベント生成時に埋め込む（RULE-55）。
Activity Event に Raw なログや Token を含めない。

**対象要件** REQ-11-019
**前提タスク** T-SEC-34
**成果物**
- `apps/security-detection/src/activity/quarantine-event.ts`
- `e2e/test/activity/quarantine-event.spec.ts`

**実装方針**
- イベントの固定値は `event_type='AGENT_QUARANTINED'`、`phase='security'`、`outcome='blocked'`、`task_id='lifecycle'`。呼び出し側から上書きできる引数にしない。
- `message` は `異常検知により Agent を隔離しました（Finding: ${finding_id}）` の1形式だけとする。テンプレートを外部から差し替える仕組みを作らない。
- `related_finding_id` は必須。`null` を許す型にしない。
- 送出先は Activity Event 用の Pub/Sub トピック `agent-activity-stream` であり、`security-events` とは別系統にする（RULE-55）。
- payload に入れてよいフィールドを `agent_id`、`human_subject`、`related_finding_id`、`risk_level`、`contributing_codes` の5つに限定し、型で固定する。`related_events` と `detail` を入れない。
- 発行は T-SEC-34 の `dispatch` が QUARANTINED の遷移依頼に成功した後に1回だけ行う。依頼が失敗した場合は発行しない。

**完了条件**
- [x] `e2e/test/activity/quarantine-event.spec.ts::critical finding emits one quarantine event` が緑になる。
- [x] `::related_finding_id is not null` が緑になる。
- [x] `::payload contains no jwt like string` が `/eyJ[A-Za-z0-9_-]{10,}/` に一致しないことを検査する。
- [x] `::no event when transition request fails` が緑になる。

---

### T-SEC-37 Blast Radius の3ケースを統合テストで固定する

**概要**
docs 05 §5 の Blast Radius 表を検証する統合テストを置く。
FULL_ISOLATION の Agent 間の到達が拒否されること、STANDARD では Shared OP が全 STANDARD Agent の Registration を読めること、Runtime 侵害時に到達できる範囲が短期トークンと Execution の DPoP 鍵と Agent Client Credential に限られることを固定する。
2つ目は許容リスクであり、テスト名にそう書く。

**対象要件** REQ-05-062
**前提タスク** T-SEC-23, T-SEC-28
**成果物**
- `e2e/test/security/blast-radius.spec.ts`
- `packages/gcp/src/firestore-guard.ts`（許可マトリクスの参照）
- `e2e/src/fixtures/two-isolated-agents.ts`

**実装方針**
- ケース(a)は、Agent A の `sa-op-<shortA>` の資格情報で `agents/{agentB_id}` と `idp_connections/{agentB_connection_id}` を読む試行が `firestore-guard` の許可マトリクスで拒否されることを assert する。IAM ではなくアプリ側パスガードで拒否される点を DEV-05 のとおりコメントに書く。
- ケース(b)のテスト名を `allows shared op to read all standard registrations (accepted risk)` とする。`accepted risk` の文字列をテスト名に含め、grep で検出できるようにする。
- ケース(c)は、Agent Runtime のプロセスから到達できるものを列挙する形で検査する。到達できること: Execution の DPoP 秘密鍵、Agent Client Credential、有効期限内の Access Token。到達できないこと: Human IdP Connection の Refresh Token（KMS 暗号化済みで Runtime に復号権限が無い）、ID-JAG 署名鍵（KMS 内、Runtime に `cloudkms.signer` が無い）、Resource AS の署名鍵（GCS の非公開バケット、Runtime に読み取り権限が無い）。
- 到達不能側は、実際に Runtime の SA で当該 API を呼んで 403 になることを assert する。モックで代替しない。
- テストは `PUBSUB_MODE=inproc` と `STORE_MODE=emulator` では成立しない部分（IAM の 403）を含むため、`make demo-apply` 後の実環境でのみ実行する e2e とする。CI では `--grep "blast-radius"` を demo プロファイルでのみ回す。
- 攻撃コードを書かない。既存の SDK 呼び出しを別 SA の資格情報で実行するだけにする。

**完了条件**
- [x] `e2e/test/security/blast-radius.spec.ts::denies agent-a dedicated sa from reading agent-b registration` が緑になる。
- [x] `::allows shared op to read all standard registrations (accepted risk)` が緑で、`grep -c "accepted risk" e2e/test/security/blast-radius.spec.ts` が1以上を返す。
- [~] `::runtime cannot reach refresh token, id-jag signing key, resource as signing key` が3つとも 403 になることを検査する。（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [x] `::runtime can reach dpop key, client credential, access token` が緑になる。（実体は `e2e/test/security/blast-radius.spec.ts`）

---

## このファイルで扱わない要件

この領域に割り当てられた35件の要件はすべて T-SEC-01 から T-SEC-37 のいずれかで扱っている。
ただし次の3件は判定ロジック本体が他領域にあり、この領域では送出点の配置とペイロードの形だけを決める。

| 要件ID | この領域で扱う範囲 | 判定ロジック本体の担当 |
|---|---|---|
| REQ-05-022 | Protocol Validation イベントの型と送出点の配置（T-SEC-12） | Identity 領域の保護ミドルウェア（DPoP 検証と Access Token 検証の実装） |
| REQ-05-075 | 10ステップの順序表と送出の固定（T-SEC-13） | Agent OP 領域の `/xaa/token` 実装（T-OP のステップ関数の組み立て） |
| REQ-05-062 | Blast Radius の検証テスト（T-SEC-37） | Dedicated OP 一式の実行時作成（T-PROV-24）と `firestore-guard` の許可マトリクス（共通基盤領域） |
