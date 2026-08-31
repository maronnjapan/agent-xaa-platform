# 10. Automation App とアクティビティタイムライン（T-APP）

Automation App は、人間が Human IdP でログインし、自動化したい作業を対話で定義し、権限決定の結果を確認して承認し、Agent の作成を依頼するための唯一の画面である。
Agent が動き出した後は、状況確認と停止と追加指示という3つの操作もこのアプリが受け付ける。
加えてこのアプリは、7つのアプリが Pub/Sub へ流す Activity Event を受け取って Firestore へ蓄え、完了した Task 単位で時系列として見せるアクティビティタイムラインを持つ。
権限の推論、Isolation の判定、Tool の許可判断はいずれも他領域が行い、このアプリはその結果を表示して人間の意思決定を仲介するだけである。
この領域が扱うのは `apps/automation-app` と、そこから使う共有パッケージの Activity Event 定義、およびタイムライン画面のフロントエンドである。

| 前提 | 内容 |
|---|---|
| 依存する領域 | idp（Human IdP のログインと Access Token）、authz（Authorization Platform の Business Work Request 受け口と Activity Event 発行）、prov（Agent Provisioner）、life（Lifecycle Manager の revoke）、run（Agent Runtime の Task 系イベント）、res（Document Resource Server）、sec（Security Detection のイベント）、iac（Pub/Sub トピック、Firestore、Cloud Run、Secret） |
| このファイルのタスク数 | 37件 |
| 主に満たす設計ルール | RULE-07, RULE-08, RULE-13, RULE-43, RULE-54, RULE-55, RULE-56, RULE-58, RULE-59, RULE-60 |

### T-APP-01 Automation App の骨格とセッションのトークン保管を実装する

**概要**
Automation App の Hono アプリ骨格、設定読み込み、セッションストア、Control Plane 3アプリへの DPoP 付き HTTP クライアントを作る。
セッションに置くトークンを `aud=automation-app` のものだけに限り、XAA 用の ID Token と Refresh Token を受け取る経路をコードから排除する。
DEC-ID-13 の経路(3)と DEC-ID-18 の typ 検査、DEC-APP-07 の `createApp()` 規約に対応する。

**対象要件** REQ-05-013, REQ-05-054
**前提タスク** なし
**成果物** `apps/automation-app/src/app.ts`, `apps/automation-app/src/index.ts`, `apps/automation-app/src/config.ts`, `apps/automation-app/src/auth/session-store.ts`, `apps/automation-app/src/auth/oidc-login.ts`, `apps/automation-app/src/auth/require-user.ts`, `apps/automation-app/src/http/control-plane-client.ts`, `apps/automation-app/test/session-store.spec.ts`, `apps/automation-app/test/require-user.spec.ts`, `scripts/checks/no-offline-access-in-automation-app.sh`

**実装方針**
- `src/app.ts` は `createApp(): Hono` を default export する。
- `src/index.ts` は `@hono/node-server` の `serve` を呼ぶだけにし、ルート定義を置かない。
- `src/config.ts` が読む環境変数は `PORT` / `ISSUER` / `AUTOMATION_APP_CLIENT_ID`（既定 `automation-app`）/ `AUTHORIZATION_PLATFORM_URL` / `AGENT_PROVISIONER_URL` / `LIFECYCLE_MANAGER_URL` / `DOCS_API_URL` / `ACTIVITY_TOPIC` / `DEFAULT_AGENT_LIFETIME_HOURS` / `VERTEX_MODEL_ID` / `VERTEX_MODE` / `STORE_MODE` の12個に限る。
- セッションは Firestore の `sessions/{session_id}` に置き、フィールドは `session_id`, `human_subject`, `id_token`, `access_tokens`（`authorization-platform` / `agent-provisioner` / `lifecycle-manager` の3キー）, `dpop_private_jwk`, `created_at`, `expires_at` の7つだけにする。
- `refresh_token` と `aud=agent-platform` の `id_token` を格納するフィールドを型定義に作らない。
- `src/auth/oidc-login.ts` の認可要求の `scope` は `openid profile` 固定とし、`offline_access` を組み立てる分岐を書かない。
- `require-user.ts` はセッション Cookie `xaa_session` から Access Token を取り出し、署名検証の直後に `typ === 'at+jwt'` を検査し、違えば 401 を返す（DEC-ID-18）。
- `aud` の判定は `packages/xaa-contracts/src/audience.ts` の `audienceIncludes(aud, expected)` を使い、部分一致と接頭辞一致を使わない（DEV-12）。
- `require-user.ts` は `c.set('humanSubject', payload.sub)` を置き、以後のハンドラは `sub` を直接読まない。
- `control-plane-client.ts` は `packages/xaa-crypto` の `createDpopProof({ htm, htu, jwk, accessToken })` を import し、`Authorization: DPoP <token>` と `DPoP: <proof>` の2ヘッダを必ず付ける。
- `scripts/checks/no-offline-access-in-automation-app.sh` は `apps/automation-app/src` 配下で `offline_access` と `refresh_token` を grep し、1件でもヒットしたら非ゼロ終了する。

**完了条件**
- [ ] `pnpm vitest run apps/automation-app/test/session-store.spec.ts` が緑で、セッションスキーマに `refresh_token` キーを追加した fixture が型検査で落ちることをテストが示す。
- [ ] `pnpm vitest run apps/automation-app/test/require-user.spec.ts -t "rejects typ other than at+jwt"` が緑になる。
- [ ] `bash scripts/checks/no-offline-access-in-automation-app.sh` が終了コード 0 を返す。
- [ ] `apps/automation-app/src/app.ts` が `createApp` を default export し、`app.fetch(new Request('http://x/healthz'))` が 200 を返す単体テストが通る。

### T-APP-02 Vertex AI 共通クライアントパッケージを実装する

**概要**
LLM 推論を行う4箇所（Automation Design AI / Authorization AI Agent / Agent Reasoning / Security AI）が共通で使うクライアントを1パッケージに切り出す。
モデル ID を環境変数で差し替え可能にし、各アプリが SDK を直接触らない状態を静的検査で固定する。
DEC-APP-10 の `vertex_model` 変数と DEC-APP-09 の `VERTEX_MODE` 切り替えに対応する。

**対象要件** REQ-01-014
**前提タスク** なし
**成果物** `packages/xaa-vertex/package.json`, `packages/xaa-vertex/src/index.ts`, `packages/xaa-vertex/src/live-client.ts`, `packages/xaa-vertex/src/fake-client.ts`, `packages/xaa-vertex/test/client.spec.ts`, `scripts/checks/no-direct-vertex-sdk.sh`

**実装方針**
- 公開 API は `generateJson<T>(params: { prompt: string; schema: object; maxOutputTokens: number; temperature: number }): Promise<T | null>` の1関数と `VertexClient` 型の2つに絞る。
- モデル ID は `VERTEX_MODEL_ID`（既定 `gemini-2.5-flash`）から読み、呼び出し側の引数に持たせない。
- `VERTEX_MODE=fake` のとき `fake-client.ts` を返し、`live` のとき `@google-cloud/vertexai` を使う `live-client.ts` を返す。
- 3つ目の共有パッケージを作る根拠は「4アプリが import する」ことであり、DEC-APP-03 の切り出し規約を満たす。
- 応答が JSON として解釈できない場合と schema 検証に落ちた場合は例外を投げず `null` を返す。
- `scripts/checks/no-direct-vertex-sdk.sh` は `apps/` と `packages/` から `packages/xaa-vertex` を除外して `@google-cloud/vertexai` を grep し、ヒットがあれば非ゼロ終了する。
- プロンプト文字列をこのパッケージに置かない。

**完了条件**
- [ ] `pnpm vitest run packages/xaa-vertex/test/client.spec.ts -t "returns null on non-json response"` が緑になる。
- [ ] `VERTEX_MODEL_ID=gemini-x` を与えたとき `live-client` に渡るモデル名が `gemini-x` であることを検証するテストが通る。
- [ ] `bash scripts/checks/no-direct-vertex-sdk.sh` が終了コード 0 を返す。

### T-APP-03 AgentStage 列挙と phase / owner の対応表を定義する

**概要**
docs 01 §1 の8段階を共有型として定義し、Activity Event の `phase` と担当アプリへの写像を1か所に置く。
以後のイベント発行と画面表示はこの表だけを参照し、段階名の別表記を作らない。
DEC-SCOPE-03 の「命名は1組に確定する」に対応する。

**対象要件** REQ-01-003
**前提タスク** なし
**成果物** `packages/xaa-contracts/src/agent-stage.ts`, `packages/xaa-contracts/test/agent-stage.spec.ts`

**実装方針**
- `AgentStage` は `define_work` / `decide_permission` / `map_to_tools` / `create_identity` / `access_resource` / `autonomous_run` / `monitor` / `destroy` の8値の union 型にする。
- `stageToPhase: Record<AgentStage, ActivityPhase>` を `define_work→work_definition`, `decide_permission→authorization`, `map_to_tools→authorization`, `create_identity→provisioning`, `access_resource→tool_call`, `autonomous_run→tool_call`, `monitor→security`, `destroy→lifecycle` で定義する。
- `stageToOwnerApp: Record<AgentStage, string[]>` を `automation` / `authorization` / `authorization` / `provisioner` / `provisioner`+`agent-op` / `runtime` / `security` / `lifecycle` で定義する。値を配列にして `create_identity` の2アプリを表現する。
- `stageToAgentStatus: Record<AgentStage, AgentStatus>` も同ファイルに置き、docs 07 §2 の9値へ写す。
- 写像は全単射ではないため、逆引き関数を作らない。

**完了条件**
- [ ] `pnpm vitest run packages/xaa-contracts/test/agent-stage.spec.ts -t "covers all 8 stages"` が緑で、8値それぞれについて3つの写像に値があることを網羅テストが確認する。
- [ ] `stageToPhase` の値域が `ActivityPhase` の7値の部分集合であることを型と実行時の両方で検証するテストが通る。
- [ ] 9値目の `AgentStage` を追加した fixture が `tsc --noEmit` で落ちることを確認する。

### T-APP-04 WorkSignalSource インタフェースと Document RS 実装を作る

**概要**
自動化候補の分析入力となる6種のソースを、Document Resource Server 上のドキュメントから統一形へ正規化して読み込む。
外部 SaaS からの取得は同じインタフェースの別実装として型だけ用意し、既定設定ではロードしない。
DEC-SCOPE-04 の `saas_connector_mode` 既定 `stub` に対応する。

**対象要件** REQ-01-001
**前提タスク** T-APP-01
**成果物** `apps/automation-app/src/signals/work-signal-source.ts`, `apps/automation-app/src/signals/document-rs-source.ts`, `apps/automation-app/src/signals/registry.ts`, `apps/automation-app/test/work-signal-source.spec.ts`

**実装方針**
- インタフェースは `interface WorkSignalSource { fetch(params: { humanSubject: string; from: string; to: string }): Promise<WorkSignal[]> }` とする。
- `WorkSignal` は `source_kind`, `occurred_at`, `human_subject`, `title`, `body`, `metadata` の6フィールドだけを持つ。
- `source_kind` は `daily_report` / `work_log` / `mail` / `calendar` / `chat` / `task` の6値で、Document RS の `type` をそのまま写す。
- `document-rs-source.ts` は `GET /documents?type=&from=&to=&limit=` と `GET /documents/{id}` を呼び、一覧が `body` を返さないため本文が要る場合だけ個別取得する。
- 呼び出しには Tool 経由ではなく Automation App 自身の SA トークンを使い、Agent の ID-JAG 経路を通さない。
- `registry.ts` は `SIGNAL_SOURCES` として `document-rs` のみを列挙し、SaaS 実装のファイルを import しない。
- SaaS 実装は `saas-source.ts` を作らず、型宣言だけを `work-signal-source.ts` のコメントに残す。

**完了条件**
- [ ] `pnpm vitest run apps/automation-app/test/work-signal-source.spec.ts -t "normalizes 6 types"` が緑で、6種の `type` を持つ入力から6件の正規化レコードが `source_kind` 正しく返る。
- [ ] `registry.ts` の `SIGNAL_SOURCES` の要素数が1であることをテストが確認する。
- [ ] 正規化レコードのキー集合が6個ちょうどであることを `Object.keys` の集合一致で確認するテストが通る。

### T-APP-05 日報作成機能を実装する

**概要**
ユーザーが期間を指定して依頼したときだけ日報を生成し、Document Resource Server へ書き込む。
入力は `source_kind=work_log` の正規化レコードに限り、生成はスケジュール実行から起動しない。
DEC-SCOPE-05 に従い、検証の主眼から遠いがタスクとして起票する。

**対象要件** REQ-02-001
**前提タスク** T-APP-02, T-APP-04
**成果物** `apps/automation-app/src/reports/daily-report.ts`, `apps/automation-app/src/reports/routes.ts`, `apps/automation-app/src/schemas/daily-report.schema.json`, `apps/automation-app/test/daily-report.spec.ts`, `e2e/tests/reports/daily-report.spec.ts`

**実装方針**
- エンドポイントは `POST /api/reports/daily`、ボディは `{ from: string, to: string }` の2フィールドのみとする。
- `humanSubject` は `require-user` が置いたコンテキスト値から取り、ボディで受け取らない。
- `work_log` のレコードを `packages/xaa-vertex` の `generateJson` へ渡し、`{ title, body }` の2フィールドの JSON を得る。
- 得た結果を Document RS の `POST /documents` へ `type=daily_report` で書き、応答の `document_id` を 201 で返す。
- Cloud Scheduler から叩ける経路を作らないため、このルートを `/internal/` 配下に置かない。
- `infra/` に日報生成用の `google_cloud_scheduler_job` を追加しない。

**完了条件**
- [ ] `pnpm vitest run apps/automation-app/test/daily-report.spec.ts` が緑になる。
- [ ] `pnpm test:e2e -- e2e/tests/reports/daily-report.spec.ts` が緑で、Document RS に `type=daily_report` のドキュメントが1件作られることを確認する。
- [ ] `grep -rn "cloud_scheduler_job" infra/ | grep -i report` が0件であることを確認する。

### T-APP-06 自動化候補の提案 API を実装する

**概要**
6ソースを集約して Vertex AI へ渡し、自動化候補のリストを得る `POST /api/automation/suggestions` を作る。
LLM 出力を JSON Schema で強制し、スキーマ外の応答は候補0件として扱ってエラーにしない。
DEC-APP-05 の「JSON Schema を単一の正とする」に対応する。

**対象要件** REQ-02-002
**前提タスク** T-APP-02, T-APP-04
**成果物** `apps/automation-app/src/automation/suggestions.ts`, `apps/automation-app/src/automation/routes.ts`, `apps/automation-app/src/schemas/suggestion.schema.json`, `apps/automation-app/src/prompts/suggestion.md`, `apps/automation-app/test/suggestions.spec.ts`

**実装方針**
- 候補1件のスキーマは `candidate_id`, `purpose`, `description`, `operations`, `user_confirmations`, `safety_notes` の6フィールドを `required` にし、`additionalProperties: false` を付ける。
- 検証は Ajv を `strict: true` で構成し、`ajv-formats` の `date-time` を有効にする。
- 検証に落ちた候補は個別に捨て、配列全体が空になったときも 200 と `{ suggestions: [] }` を返す。
- 例外を投げて 500 になる分岐を作らない。
- 入力の期間は `from` / `to` の2フィールドのみで、`human_subject` はコンテキストから取る。
- `prompts/suggestion.md` に Capability 識別子、Resource 名、Isolation Level を書かない（REQ-02-006）。

**完了条件**
- [ ] `pnpm vitest run apps/automation-app/test/suggestions.spec.ts -t "schema violation yields empty list"` が緑で、応答が 200 かつ `suggestions` が空配列になる。
- [ ] 正常応答のケースで各候補が6フィールドすべてを持つことを assert するテストが通る。
- [ ] `apps/automation-app/src/prompts/suggestion.md` に対する `grep -E "full_isolation|\.read|\.write"` が0件になる。

### T-APP-07 Work Definition のデータモデルと DRAFT / CONFIRMED 遷移を実装する

**概要**
Automation Design AI が決める3項目だけを持つ Work Definition モデルを定義し、状態を `DRAFT` と `CONFIRMED` の2値に固定する。
確定はユーザーの明示操作だけで起き、LLM の応答内容や時間経過では起きない。
RULE-08 の「AI が最終確定しない」に対応する。

**対象要件** REQ-02-003, REQ-02-005
**前提タスク** T-APP-06
**成果物** `apps/automation-app/src/work-definition/model.ts`, `apps/automation-app/src/work-definition/store.ts`, `apps/automation-app/src/work-definition/routes.ts`, `apps/automation-app/src/schemas/work-definition.schema.json`, `apps/automation-app/test/work-definition-state.spec.ts`

**実装方針**
- Firestore のコレクションは `work_definitions/{work_definition_id}` とし、フィールドは `work_definition_id`, `human_subject`, `status`, `purpose`, `description`, `operations`, `user_confirmations`, `safety_notes`, `requested_lifetime_hours`, `created_at`, `updated_at` の11個だけにする。
- `operations` は順序付き配列として保存し、Firestore の書き込み時に `FieldValue.arrayUnion` を使わない。
- `status` は `DRAFT` と `CONFIRMED` の2値のみで、`CONFIRMING` のような中間値を作らない。
- 確定は `POST /api/work-definitions/{id}/confirm` だけが `status` を書き換える。
- 対話 API（`POST /api/work-definitions/{id}/messages`）は `status` フィールドへ書き込む処理を持たない。
- 時間経過で遷移させないため、`status` を評価する Cloud Scheduler ジョブと Firestore トリガを作らない。
- `CONFIRMED` でない Work Definition から Business Work Request を送ろうとした場合は 409 と `work_definition_not_confirmed` を返す（送信の実装は T-APP-09）。

**完了条件**
- [ ] `pnpm vitest run apps/automation-app/test/work-definition-state.spec.ts -t "stays DRAFT despite LLM confirmation phrase"` が緑になる。
- [ ] 保存して読み戻した `operations` の配列順序が入力と一致することをテストが確認する。
- [ ] モデルのキー集合が上記11個ちょうどであることを集合一致で確認するテストが通る。
- [ ] `DRAFT` 状態で送信 API を呼ぶと 409 と `work_definition_not_confirmed` が返るテストが通る。

### T-APP-08 requested_lifetime_hours の範囲検証と UI 初期値を実装する

**概要**
希望生存時間を 1 以上 24 以下の整数に限り、範囲外を送信前に 400 で止める。
検証コストを抑えるため UI の初期値を環境変数から与え、上限 24 は変えない。
DEC-IAC-16 の `agent_max_lifetime_seconds` と UI 初期値を連動させる。

**対象要件** REQ-02-007
**前提タスク** T-APP-07
**成果物** `apps/automation-app/src/work-definition/lifetime.ts`, `apps/automation-app/src/ui/components/lifetime-input.tsx`, `apps/automation-app/test/lifetime.spec.ts`

**実装方針**
- 検証関数は `validateLifetimeHours(value: unknown): number` とし、整数でない値と 1 未満と 24 超をすべて弾く。
- 拒否時は 400 と `{ error: 'lifetime_out_of_range' }` を返す。
- UI の `input[type=number]` に `min=1` と `max=24` を付け、`value` の初期値を `DEFAULT_AGENT_LIFETIME_HOURS`（既定 1）から与える。
- 上限を環境変数で変えられるようにしない。
- 小数を四捨五入して通す分岐を作らない。

**完了条件**
- [ ] `pnpm vitest run apps/automation-app/test/lifetime.spec.ts -t "rejects 25"` と `-t "accepts 24"` の2件が緑になる。
- [ ] `1.5` と `"3"` と `0` の3入力がいずれも 400 と `lifetime_out_of_range` になるテストが通る。
- [ ] `DEFAULT_AGENT_LIFETIME_HOURS=2` を与えた SSR 出力の `value` 属性が `2` になることをテストが確認する。

### T-APP-09 Business Work Request の送信を実装する

**概要**
`CONFIRMED` の Work Definition から Business Work Request を組み立て、Authorization Platform へ送る。
ボディに Capability、Resource 名、scope、audience、Tool ID を含めず、権限の語彙を Automation App から出さない。
RULE-07 と RULE-43 に対応する。

**対象要件** REQ-02-008
**前提タスク** T-APP-01, T-APP-07, T-APP-08
**成果物** `apps/automation-app/src/work-definition/submit.ts`, `apps/automation-app/src/schemas/business-work-request.schema.json`, `apps/automation-app/test/business-work-request.spec.ts`

**実装方針**
- 送信先は `POST {AUTHORIZATION_PLATFORM_URL}/api/work-requests`。
- ボディは `human_subject`, `purpose`, `description`, `constraints`, `requested_lifetime_hours` の5キーだけとし、スキーマに `additionalProperties: false` を付ける。
- `constraints` は真偽値のみを値に取るマップとし、`external_message_send` を含む。
- 送信前に自前のスキーマ検証を通し、キーが5個でなければ送信せず 500 を返す。
- トークンはセッションの `access_tokens['authorization-platform']` を使い、`aud` に `authorization-platform` が要素として含まれること、`scope` に `workdef:submit` が含まれることを送信側でも確認する。
- 呼び出しは `control-plane-client.ts` 経由とし、DPoP Proof の `htm=POST` と `htu` を送信先 URL から組み立てる。
- Capability 名や Tool ID をボディへ入れる分岐をコードに書かない。

**完了条件**
- [ ] `pnpm vitest run apps/automation-app/test/business-work-request.spec.ts -t "body has exactly 5 keys"` が緑になる。
- [ ] `aud` が異なる Access Token を持たせると送信が行われず 500 になることをテストが確認する。
- [ ] integration テストで Authorization Platform 側の `app.fetch` が受け取ったボディのキー集合が5個であることを assert する。

### T-APP-10 承認レコードと Capability ハッシュ照合を実装する

**概要**
Authorization Platform から返った Effective Capability と Security Profile をユーザーへ提示し、明示的な承認を経てから Agent Provisioner を呼ぶ。
提示時の Capability 集合のハッシュを保存し、送信時に一致しなければ中止する。
RULE-08 の「ユーザー承認なしに Provisioning を送らない」に対応する。

**対象要件** REQ-02-004
**前提タスク** T-APP-09
**成果物** `apps/automation-app/src/agent-definition/approval.ts`, `apps/automation-app/src/agent-definition/routes.ts`, `apps/automation-app/src/agent-definition/provision-request.ts`, `apps/automation-app/test/approval.spec.ts`

**実装方針**
- Firestore の `agent_definitions/{agent_definition_id}` に `presented_capabilities`, `presented_capabilities_hash`, `isolation_level`, `approved_by`, `approved_at` を保存する。
- ハッシュは Capability 文字列を昇順ソートして `\n` で連結し、SHA-256 の base64url を取る（`packages/xaa-crypto` の `sha256Base64url` を使う）。
- 承認は `POST /api/agent-definitions/{id}/approve` のみで書き、承認済みレコードの上書きを許さない。
- Provisioning 送信は `POST /api/agent-definitions/{id}/provision` で、`approved_at` が null なら 409 と `approval_required` を返す。
- 送信直前に Effective Capability を再取得してハッシュを計算し、`presented_capabilities_hash` と一致しなければ送信せず 409 と `capabilities_changed` を返す。
- 送信先は `POST {AGENT_PROVISIONER_URL}/api/provisioning`、トークンは `aud=agent-provisioner`。
- 一致しない場合に再承認へ自動遷移させる分岐を作らない。

**完了条件**
- [ ] `pnpm vitest run apps/automation-app/test/approval.spec.ts -t "provision without approval returns 409"` が緑になる。
- [ ] 承認後に Effective Capability を1件足して送信すると 409 と `capabilities_changed` が返るテストが通る。
- [ ] Capability の並び順だけを入れ替えた集合でハッシュが一致することを確認するテストが通る。

### T-APP-11 権限とResourceとIsolationの語彙を持ち込まない検査を作る

**概要**
Automation App のソースとプロンプトテンプレートから、Capability 識別子、Resource 一覧、Isolation 判定ロジックを排除する。
Authorization Platform から受け取った値は表示専用の文字列としてのみ扱う。
RULE-07 を静的検査で固定する。

**対象要件** REQ-02-006
**前提タスク** T-APP-06, T-APP-10
**成果物** `scripts/checks/no-authz-vocabulary-in-automation-app.sh`, `apps/automation-app/test/fixtures/presented-capabilities.fixture.ts`, `.github/workflows/ci.yml`（ジョブ追加）

**実装方針**
- 検査対象は `apps/automation-app/src/**/*.ts`, `apps/automation-app/src/**/*.tsx`, `apps/automation-app/src/prompts/**` とする。
- 除外は `apps/automation-app/src/**/fixtures/**` と `apps/automation-app/test/**` と `demo-scenarios/**` の3つに限る。
- 検出する語は `calendar.event.` / `document.read` / `document.write` / `mail.message.` / `finance.payment.` / `full_isolation` / `standard_isolation` / `docs.read` / `docs.write` / `finance.tx.` の10パターンとする。
- Capability Taxonomy を参照する HTTP 呼び出しを追加しないため、`control-plane-client.ts` に taxonomy 用のメソッドを作らない。
- 画面は `effective_capabilities` を `string[]` として受け取り、要素を解釈せずそのまま列挙する。
- Isolation Level は表示用の文字列としてのみ扱い、比較や大小判定を行う関数を書かない。

**完了条件**
- [ ] `bash scripts/checks/no-authz-vocabulary-in-automation-app.sh` が終了コード 0 を返す。
- [ ] 検査対象内へ `full_isolation` を1行足した状態で同スクリプトが非ゼロ終了することを確認する。
- [ ] CI のジョブ `checks:automation-vocabulary` が緑になる。

### T-APP-12 Agent 操作系の human_subject 一致認可を実装する

**概要**
状況確認と停止と追加指示の3操作で、`agents/{agent_id}/meta` の `human_subject` を先に読み、Access Token の `sub` と一致する場合のみ処理する。
不一致は Agent の存在を漏らさないため 404 を返す。
RULE-43 と RULE-56 に対応する。

**対象要件** REQ-02-022
**前提タスク** T-APP-01
**成果物** `apps/automation-app/src/agents/require-owner.ts`, `packages/gcp/src/firestore-guard.ts`（許可パスの追記）, `apps/automation-app/test/require-owner.spec.ts`, `scripts/checks/no-direct-agent-state-read.sh`

**実装方針**
- `requireAgentOwner` は Hono のミドルウェアとして `/api/agents/:agent_id/*` すべてに適用する。
- 読み取り順は `agents/{agent_id}/meta` の `human_subject` → `sub` との一致判定 → 一致時のみ `c.set('agentId', ...)` とする。
- 不一致と Agent 不在の両方で 404 と `{ error: 'not_found' }` を返し、403 を返す分岐を作らない。
- `agents/{agent_id}/state` を読む関数は `require-owner.ts` を経たコンテキスト値からのみ `agent_id` を受け取る型にする。
- `scripts/checks/no-direct-agent-state-read.sh` は `apps/automation-app/src` で `agents/` を含む Firestore パス組み立てを grep し、`require-owner.ts` と `agents/` 配下のモジュール以外にヒットがあれば非ゼロ終了する。
- `packages/gcp/src/firestore-guard.ts` の許可マトリクスへ automation-app の許可パス（`sessions/**`, `work_definitions/**`, `agent_definitions/**`, `agents/*/meta` 読み取り, `agents/*/state` 読み取り, `agents/*/instructions/**`, `users/*/activity/**`）を追記する。

**完了条件**
- [ ] `pnpm vitest run apps/automation-app/test/require-owner.spec.ts -t "returns 404 for other user"` が緑で、状況確認と停止と追加指示の3経路すべてが 404 になる。
- [ ] 応答ボディに `403` も `forbidden` も現れないことを assert するテストが通る。
- [ ] `bash scripts/checks/no-direct-agent-state-read.sh` が終了コード 0 を返す。
- [ ] `pnpm vitest run packages/gcp/test/firestore-guard.spec.ts` が緑になる。

### T-APP-13 実行中 Agent の状況確認 API を実装する

**概要**
`agents/{agent_id}/state` の Checkpoint を読み、状態と残り時間と現在のタスクと Tool 実行結果の4項目を返す。
機微なトークン類をレスポンスに含めない。
RULE-38 に対応する。

**対象要件** REQ-02-021
**前提タスク** T-APP-12
**成果物** `apps/automation-app/src/agents/status.ts`, `apps/automation-app/src/schemas/agent-status-response.schema.json`, `apps/automation-app/test/agent-status.spec.ts`

**実装方針**
- エンドポイントは `GET /api/agents/{agent_id}/status`。
- 返す4項目は `agent_status`, `remaining_seconds`, `current_task`, `tool_invocations` に固定する。
- `agent_status` の値域は `CREATED` / `PROVISIONING` / `ACTIVE` / `EXPIRING` / `EXPIRED` / `SUSPICIOUS` / `QUARANTINED` / `REVOKED` / `DESTROYED` の9値。
- `remaining_seconds` は `expires_at - now` を秒に丸め、負なら 0 にする。
- `tool_invocations` の要素は `tool_id`, `outcome`, `summary` の3フィールドだけに射影する。
- レスポンス組み立てを allowlist 方式にし、Checkpoint のオブジェクトをスプレッドして返さない。
- 応答スキーマを Ajv で検証してから返し、検証に落ちたら 500 を返す。

**完了条件**
- [ ] `pnpm vitest run apps/automation-app/test/agent-status.spec.ts -t "returns exactly 4 keys"` が緑になる。
- [ ] `token` / `secret` / `private_key` を含むキーが応答 JSON に存在しないことを再帰的に検査するテストが通る。
- [ ] `expires_at` が過去の Checkpoint で `remaining_seconds` が 0 になるテストが通る。

### T-APP-14 Agent 停止操作を Lifecycle Manager へ委譲する

**概要**
停止操作を Automation App 自身では行わず、Lifecycle Manager の revoke を呼ぶ。
Cloud Run Job の cancel と KMS 操作を Automation App から行わない。
RULE-27 と RULE-41 に対応する。

**対象要件** REQ-02-023
**前提タスク** T-APP-12
**成果物** `apps/automation-app/src/agents/stop.ts`, `apps/automation-app/test/agent-stop.spec.ts`, `e2e/tests/lifecycle/stop-agent.spec.ts`, `infra/tests/automation-app-roles.sh`

**実装方針**
- エンドポイントは `POST /api/agents/{agent_id}/stop`。
- 呼び出し先は `POST {LIFECYCLE_MANAGER_URL}/api/agents/{agent_id}/revoke`。
- トークンはセッションの `access_tokens['lifecycle-manager']` を使い、`scope` に `agent:revoke` が含まれることを送信側でも確認する。
- DPoP Proof を `htm=POST`、`htu` を revoke の URL で組み立て、`ath` を Access Token から計算して付ける（DEC-ID-12）。
- Lifecycle Manager が 2xx を返したときのみ 200 を返し、それ以外は上流のステータスをそのまま返す。
- `@google-cloud/run` と `@google-cloud/kms` を `apps/automation-app` の依存へ追加しない。
- `infra/tests/automation-app-roles.sh` は `sa-automation-app` に `roles/run.admin` / `roles/run.developer` / `roles/cloudkms.*` が付いていないことを terraform plan の JSON から検査する。

**完了条件**
- [ ] `pnpm vitest run apps/automation-app/test/agent-stop.spec.ts -t "delegates to lifecycle manager"` が緑になる。
- [ ] `pnpm test:e2e -- e2e/tests/lifecycle/stop-agent.spec.ts` が緑で、Agent Identity Domain の `status` が `DESTROYED` になることを確認する。
- [ ] `bash infra/tests/automation-app-roles.sh` が終了コード 0 を返す。
- [ ] `apps/automation-app/package.json` の dependencies に `@google-cloud/run` と `@google-cloud/kms` が無いことを確認する。

### T-APP-15 追加指示の書き込みと適用状態を実装する

**概要**
実行中の Agent へ自然文の追加指示を1件追記し、Agent Runtime が読み取れるようにする。
`ACTIVE` 以外の Agent には追記せず 409 で拒否する。
RULE-13 と RULE-17 に対応する。

**対象要件** REQ-02-024
**前提タスク** T-APP-12, T-APP-13
**成果物** `apps/automation-app/src/agents/instructions.ts`, `apps/automation-app/src/schemas/instruction-request.schema.json`, `apps/automation-app/test/instructions.spec.ts`

**実装方針**
- エンドポイントは `POST /api/agents/{agent_id}/instructions`、ボディは `{ text: string }` の1キーだけとする。
- リクエストスキーマに `capabilities` / `tools` / `scope` / `audience` / `url` のいずれのプロパティも定義せず、`additionalProperties: false` を付ける。
- 書き込み先は `agents/{agent_id}/instructions/{instruction_id}`、フィールドは `instruction_id`, `text`, `created_at`, `created_by`, `applied_at` の5つ。
- `applied_at` は書き込み時に `null` を入れ、更新は Agent Runtime 側が行う。
- 追記の前に `agents/{agent_id}/state` の `agent_status` を読み、`ACTIVE` 以外なら書き込まず 409 と `agent_not_active` を返す。
- 状態確認と書き込みを Firestore の `runTransaction` で1つにまとめ、確認後に状態が変わる競合を避ける。
- `created_by` には `sub` を入れ、Access Token 文字列を入れない。

**完了条件**
- [ ] `pnpm vitest run apps/automation-app/test/instructions.spec.ts -t "ACTIVE agent accepts one instruction"` が緑で、Firestore に1件だけ追加される。
- [ ] `EXPIRED` の Agent で 409 と `agent_not_active` が返るテストが通る。
- [ ] `{ text: "x", capabilities: ["a"] }` を送ると 400 になることをテストが確認する。
- [ ] `apps/automation-app/src/schemas/instruction-request.schema.json` の `properties` が `text` の1キーだけであることを確認する。

### T-APP-16 権限拡大時に新規 Agent 作成へ誘導する画面を実装する

**概要**
追加指示が権限外 Tool で拒否されたとき、既存 Agent の権限を変える導線を出さず、Work Definition の再定義から始める導線だけを提示する。
既存 Agent の `effective_capabilities` を更新する API を実装しない。
デモ D-1 の結末に対応する。

**対象要件** REQ-02-027
**前提タスク** T-APP-15, T-APP-13
**成果物** `apps/automation-app/src/ui/components/blocked-guidance.tsx`, `apps/automation-app/src/ui/pages/agent-detail.tsx`, `scripts/checks/no-capability-update-route.sh`, `e2e/tests/agents/blocked-guidance.spec.ts`

**実装方針**
- `agent-detail.tsx` は状況確認の `tool_invocations` に `outcome === 'blocked'` が1件以上あるとき `blocked-guidance.tsx` を描画する。
- 誘導先のリンクは `/work-definitions/new` の1本だけとし、`?agent_id=` のようなクエリで既存 Agent を引き継がない。
- 「権限を追加する」「Capability を編集する」といったボタンとリンクを作らない。
- `scripts/checks/no-capability-update-route.sh` は `apps/automation-app/src` のルート定義から `app.put` と `app.patch` を抽出し、パスに `capabilit` または `effective` を含むものが1件でもあれば非ゼロ終了する。
- 誘導文言は「この Agent の権限は変更できません。新しい Agent を作成してください。」に固定する。

**完了条件**
- [ ] `bash scripts/checks/no-capability-update-route.sh` が終了コード 0 を返す。
- [ ] `pnpm test:e2e -- e2e/tests/agents/blocked-guidance.spec.ts` が緑で、拒否後の画面に `/work-definitions/new` へのリンクが1本だけ存在することを確認する。
- [ ] 同 e2e で「権限を追加」を含む文字列が画面に存在しないことを assert する。

### T-APP-17 Agent 操作3種の監査ログを実装する

**概要**
状況確認と停止と追加指示について、操作者と対象と結果を構造化ログとして出す。
他人の Agent への操作で 404 になったケースも `denied` として記録する。
DEC-SEC-01 の「アプリが構造化ログを Cloud Logging へ出す」に対応する。

**対象要件** REQ-02-028
**前提タスク** T-APP-12, T-APP-13, T-APP-14, T-APP-15
**成果物** `apps/automation-app/src/audit/logger.ts`, `apps/automation-app/src/audit/agent-operations.ts`, `apps/automation-app/test/audit-agent-operations.spec.ts`

**実装方針**
- ログは JSON 1行を stdout へ書き、`severity`, `logType: 'xaa.audit'` を含める。
- 記録する項目は `operation`, `agent_id`, `actor_type`, `actor_id`, `on_behalf_of`, `occurred_at`, `result` の7つ。
- `operation` は `status_read` / `stop` / `add_instruction` の3値、`result` は `success` / `denied` の2値に固定する。
- `actor_type` は `human` 固定、`actor_id` と `on_behalf_of` はどちらも `sub` を入れる。
- 追加指示の場合だけ `instruction_text` を追加し、`text` の内容をそのまま記録する。
- `require-owner.ts` が 404 を返す経路でも `result=denied` のログを出すため、ミドルウェアの拒否分岐から `logAgentOperation` を呼ぶ。
- Access Token と DPoP Proof の文字列をログへ入れない。ログ関数の引数型に `token` を受ける口を作らない。

**完了条件**
- [ ] `pnpm vitest run apps/automation-app/test/audit-agent-operations.spec.ts -t "emits one line per operation"` が緑で、3操作それぞれ1件出る。
- [ ] 他人の Agent への3操作で `result=denied` の行が3件出ることをテストが確認する。
- [ ] 出力された全ログ行に対し、テストで発行した Access Token 文字列が部分文字列として含まれないことを assert する。

### T-APP-18 状況確認とタイムラインの導線を分離する

**概要**
Agent 詳細画面に、現在のスナップショットを示す状況確認と、完了した Task を再生するタイムラインの導線を別々に置く。
タイムラインが実行中の Task を逐次表示しないことを画面上に明示する。
RULE-59 に対応する。

**対象要件** REQ-02-030
**前提タスク** T-APP-13, T-APP-16
**成果物** `apps/automation-app/src/ui/pages/agent-detail.tsx`, `apps/automation-app/src/ui/components/status-panel.tsx`, `apps/automation-app/src/ui/components/timeline-link.tsx`, `e2e/tests/agents/status-timeline-separation.spec.ts`

**実装方針**
- 状況確認は `status-panel.tsx` として画面上部に置き、`GET /api/agents/{agent_id}/status` を1回呼んで描画する。
- タイムラインへの導線は `timeline-link.tsx` として別のセクションに置き、`/activity?agent_id=` へ遷移させる。
- 2つの領域に `data-section="status"` と `data-section="timeline-link"` を付け、DOM 上で別要素にする。
- タイムライン導線の直下に「完了した処理だけを再生します。実行中の処理は状況確認で見てください。」を常時表示する。
- 状況確認のパネルからタイムラインのイベント配列を読む処理を書かない。
- タイムラインのリンクが実行中 Task の件数を表示しない。

**完了条件**
- [ ] `pnpm test:e2e -- e2e/tests/agents/status-timeline-separation.spec.ts` が緑になる。
- [ ] 実行中 Agent の画面で `data-section="status"` が最新 Checkpoint 由来の `agent_status` を表示し、タイムライン側に未完了 Task の行が0件であることを assert する。
- [ ] 説明文が常時表示され、折りたたみの内側に無いことを assert する。

### T-APP-19 Activity Event スキーマを定義し検証する

**概要**
docs 11 §3.1 の Activity Event を JSON Schema として定義し、`phase` 7値と `outcome` 3値を enum で固定する。
発行側と受信側の両方でこのスキーマを通す。
RULE-55 の「表示専用イベントを別系統で持つ」の土台になる。

**対象要件** REQ-11-001, REQ-11-003
**前提タスク** T-APP-03
**成果物** `packages/xaa-contracts/src/schemas/activity-event.schema.json`, `packages/xaa-contracts/src/activity-event.ts`, `packages/xaa-contracts/test/activity-event-schema.spec.ts`, `packages/xaa-contracts/test/fixtures/activity-event-docs-example.json`

**実装方針**
- フィールドは `event_id`, `trace_id`, `human_subject`, `agent_id`, `task_id`, `occurred_at`, `source`, `phase`, `outcome`, `title`, `message`, `detail`, `related_finding_id`, `is_simulated` の14個とし、`additionalProperties: false` を付ける。
- `required` は `detail` を除く13個とする。
- `agent_id` と `related_finding_id` は `["string", "null"]` を許し、`detail` は `object` で省略可、`is_simulated` は `default: false` の `boolean`。
- `phase` の enum は `login`, `work_definition`, `authorization`, `provisioning`, `tool_call`, `security`, `lifecycle` の7値。
- `outcome` の enum は `info`, `success`, `blocked` の3値に固定し、`denied` / `rejected` / `error` を追加しない。
- `occurred_at` は `format: date-time`。
- 型は `json-schema-to-ts` で `ActivityEvent` として導出し、手書きの interface を並置しない（DEC-APP-05）。
- 検証関数 `validateActivityEvent(input): ActivityEvent` を Ajv（`strict: true`）で1つだけ export し、発行側と受信側の両方がこれを呼ぶ。

**完了条件**
- [ ] `pnpm vitest run packages/xaa-contracts/test/activity-event-schema.spec.ts -t "rejects 8th phase"` が緑になる。
- [ ] `outcome: 'denied'` の入力が拒否され、enum の要素数が3であることを assert するテストが通る。
- [ ] `activity-event-docs-example.json`（docs 11 §3.1 の YAML を JSON 化したもの）がそのまま受理されることを assert する。
- [ ] `detail` を省いた入力が受理され、未知キーを1つ足した入力が拒否されることを assert する。

### T-APP-20 task_id の3種と終端イベント表を定義する

**概要**
再生の単位である `task_id` を3形式に限り、それぞれの終端イベントを定数表として置く。
終端判定はこの表だけを参照し、イベント名の文字列比較を各所へ散らさない。
RULE-59 に対応する。

**対象要件** REQ-11-008
**前提タスク** T-APP-19
**成果物** `packages/xaa-contracts/src/task-boundary.ts`, `packages/xaa-contracts/test/task-boundary.spec.ts`

**実装方針**
- `TASK_ID_PATTERN` を `/^(provisioning|lifecycle|task-[1-9][0-9]*|demo-[a-z-]+)$/` として1か所に置く。
- `TERMINAL_EVENTS` は `{ provisioning: ['AGENT_PROVISIONED'], 'task-{n}': ['TASK_COMPLETED','TASK_BLOCKED','TASK_FAILED'], lifecycle: ['AGENT_EXPIRED','AGENT_STOPPED','AGENT_QUARANTINED','AGENT_REVOKED_SECURITY'] }` の3キー8値とする。
- `classifyTaskId(taskId): 'provisioning' | 'task' | 'lifecycle' | 'demo' | null` を export し、不正形式は `null` を返す。
- `isTerminalEvent(taskId, eventType): boolean` を export し、この2関数以外で終端判定を書かない。
- `demo-{scenario_id}` は台本用の第4形式として `TASK_ID_PATTERN` に含めるが、`TERMINAL_EVENTS` は持たず常に終端扱いにする（T-APP-35 で使う）。
- イベント種別は Activity Event の `detail.event_type` ではなく、専用フィールドを増やさずに `title` から判定する実装にしない。`event_type` を `detail` の必須キーとして扱う旨をこのファイルの型で明示する。

**完了条件**
- [ ] `pnpm vitest run packages/xaa-contracts/test/task-boundary.spec.ts -t "rejects task-abc"` が緑になる。
- [ ] `TERMINAL_EVENTS` の全値を平坦化した集合が docs 11 §3.3 の8種と一致することを集合比較で assert する。
- [ ] `task-0` と `task-01` と `provisioning-1` の3つが `null` になることを assert する。

### T-APP-21 Activity Event の発行関数を共有パッケージへ実装する

**概要**
7アプリが共通で使う Activity Event の publish 関数を作り、`title` と `message` を必須引数にする。
Cloud Logging と BigQuery を経由させず、Pub/Sub トピック1本へ直接送る。
DEC-DEMO-01 と REQ-11-005 に従い、トピック名を `agent-activity-stream` に一本化する。

**対象要件** REQ-11-002, REQ-11-005
**前提タスク** T-APP-19, T-APP-20
**成果物** `packages/xaa-contracts/src/activity-publisher.ts`, `packages/xaa-contracts/test/activity-publisher.spec.ts`, `scripts/checks/activity-event-single-channel.sh`, `e2e/tests/activity/separate-channel.spec.ts`

**実装方針**
- 公開関数は `publishActivityEvent(event: ActivityEvent): Promise<void>` の1つとする。
- トピック名の定数 `ACTIVITY_TOPIC = 'agent-activity-stream'` をこのファイルに置き、他のどこにも別名を作らない。REQ-02-029 の `activity-events` は DEC-SCOPE-03 に従い破棄する。
- 引数の `title` と `message` を `string` の必須プロパティとし、空文字を実行時に弾いて例外を投げる。
- publish の前に `validateActivityEvent` を通す。
- `PUBSUB_MODE=inproc` のときはメモリ上のキューへ積み、`gcp` のとき `@google-cloud/pubsub` を使う（DEC-APP-09）。
- Cloud Logging へ Activity Event を書く関数を作らない。`console.log` で `activity_event` を出す分岐も作らない。
- BigQuery クライアントをこのファイルから import しない。
- `scripts/checks/activity-event-single-channel.sh` は `apps/` と `packages/` で `activity-events`（旧名）と `activity_event` を伴う logging 呼び出しを grep し、ヒットがあれば非ゼロ終了する。

**完了条件**
- [ ] `pnpm vitest run packages/xaa-contracts/test/activity-publisher.spec.ts -t "rejects empty title"` と `-t "rejects empty message"` が緑になる。
- [ ] `bash scripts/checks/activity-event-single-channel.sh` が終了コード 0 を返す。
- [ ] `pnpm test:e2e -- e2e/tests/activity/separate-channel.spec.ts` が緑で、Activity Event を1件発行した後に `security_audit.normalized_events` の行数が増えないことを assert する。
- [ ] 同 e2e で Cloud Logging のエントリに Activity Event の `message` が現れないことを assert する。

### T-APP-22 Automation App の Activity Event 4種を発行する

**概要**
Automation App が発行するのは LOGGED_IN、PROPOSED、CONFIRMED、AGENT_STOPPED の4種だけである。
それぞれの `phase` と `outcome` と `task_id` を固定し、日本語の `title` と `message` を発行時点で作る。
RULE-55 と RULE-60 に対応する。

**対象要件** REQ-02-029, REQ-11-014
**前提タスク** T-APP-21, T-APP-06, T-APP-07, T-APP-14
**成果物** `apps/automation-app/src/activity/emit.ts`, `apps/automation-app/test/activity-emit.spec.ts`, `e2e/tests/activity/events-automation.spec.ts`

**実装方針**
- `emit.ts` は `emitLoggedIn`, `emitProposed`, `emitConfirmed`, `emitAgentStopped` の4関数だけを export する。
- LOGGED_IN は `phase=login`, `outcome=info`, `agent_id=null`, `task_id='provisioning'`, `title='ログインしました'`。
- PROPOSED は `phase=work_definition`, `outcome=info`, `task_id='provisioning'`, `message` に `purpose` を埋め込む（`Automation Design AI が「{purpose}」を提案しました`）。
- CONFIRMED は `phase=work_definition`, `outcome=success`, `task_id='provisioning'`, `title='作業内容を確定しました'`。
- AGENT_STOPPED は `phase=lifecycle`, `outcome=success`, `task_id='lifecycle'`, `title='Agent を停止しました'`。
- `human_subject` は `require-user` が置いたコンテキスト値から取り、リクエストボディから取らない。
- `detail.event_type` に上記4つの識別子を入れる。
- 5種目のイベントを Automation App から発行しない。他アプリのイベント名をこのファイルに書かない。

**完了条件**
- [ ] `pnpm vitest run apps/automation-app/test/activity-emit.spec.ts -t "exports exactly 4 emitters"` が緑になる。
- [ ] `pnpm test:e2e -- e2e/tests/activity/events-automation.spec.ts` が緑で、ログインから停止までの操作で4件が正しい `phase` / `outcome` / `task_id` で1件ずつ publish される。
- [ ] 4件すべての `title` と `message` が空でなく、ASCII のみの文字列でないことを assert する。

### T-APP-23 Activity Subscriber を実装し Firestore へ冪等に書き込む

**概要**
Pub/Sub の push subscription を受け、スキーマ検証したイベントを Firestore へ書き込む。
at-least-once の再配信で重複しないよう、ドキュメント ID を `event_id` にして create のみ行う。
RULE-55 と RULE-57 に対応する。

**対象要件** REQ-11-006, REQ-11-007
**前提タスク** T-APP-19, T-APP-21
**成果物** `apps/automation-app/src/activity/subscriber.ts`, `apps/automation-app/src/activity/oidc-verify.ts`, `apps/automation-app/test/activity-subscriber.spec.ts`, `e2e/tests/activity/subscriber.spec.ts`, `e2e/tests/activity/idempotent.spec.ts`

**実装方針**
- エンドポイントは `POST /internal/activity/push`。
- Pub/Sub が付ける OIDC Token を `Authorization: Bearer` から取り、`iss` が Google の発行者、`aud` が Cloud Run の URL、`email` が `sa-pubsub-push` であることを検証する。検証に落ちたら 401 を返す。
- ボディの `message.data` を base64 デコードし、`validateActivityEvent` を通す。検証に落ちたら 400 を返して再配信させない。
- 書き込み先は `users/{human_subject}/activity/{event_id}`。`human_subject` はイベント本文から取る（Subscriber は Pub/Sub 経由のためユーザーセッションを持たない）。
- 書き込みは `docRef.create()` を使い、`ALREADY_EXISTS` を捕捉して 200 を返す。`set()` と `merge` を使わない。
- `expire_at` を `occurred_at + 7 日` として付与し、Firestore の TTL ポリシーのフィールドに使う（TTL ポリシー自体は T-IAC 領域）。
- ブラウザへ配信する処理をこのファイルに書かない。

**完了条件**
- [ ] `pnpm test:e2e -- e2e/tests/activity/subscriber.spec.ts` が緑で、1件 push すると該当パスに1ドキュメントができ、`expire_at` が `occurred_at + 7 日` になる。
- [ ] OIDC Token 無しの POST が 401 になることを assert する。
- [ ] `pnpm test:e2e -- e2e/tests/activity/idempotent.spec.ts` が緑で、同じ `event_id` を3回 push してもドキュメントが1件のままで内容が初回のものである。
- [ ] スキーマ違反のボディが 400 を返し Firestore に書かれないことを単体テストが確認する。

### T-APP-24 タイムライン取得 API を実装する

**概要**
Firestore の Activity Event を `task_id` ごとに集約し、終端イベントが揃った Task だけ中身を返す。
参照範囲を Access Token の `sub` に固定し、他ユーザーの `task_id` は 404 にする。
RULE-56 と RULE-59 に対応する。

**対象要件** REQ-11-009, REQ-11-011
**前提タスク** T-APP-20, T-APP-23, T-APP-12
**成果物** `apps/automation-app/src/activity/query.ts`, `apps/automation-app/src/activity/routes.ts`, `apps/automation-app/src/schemas/timeline-response.schema.json`, `apps/automation-app/test/activity-query.spec.ts`, `e2e/tests/activity/incomplete-task.spec.ts`, `e2e/tests/activity/access-control.spec.ts`

**実装方針**
- エンドポイントは `GET /api/activity/tasks` と `GET /api/activity/tasks/{task_id}` の2本。
- Firestore のクエリパスは `users/${humanSubject}/activity` としてコンテキスト値から組み立て、クエリパラメータとボディを一切混ぜない。
- `?human_subject=` を受け取っても読み捨てる。パラメータの存在を理由に 400 を返さない。
- 集約は `task_id` ごとに行い、`isTerminalEvent` が真のイベントが1件以上あるものを完了扱いにする。
- 完了 Task は `{ task_id, agent_id, purpose, status: 'completed', terminal_outcome, completed_at, events }` を返す。
- 未完了 Task は `{ task_id, agent_id, purpose, status: 'running' }` の4キーだけを返し、`events` キー自体を出力しない。
- `GET /api/activity/tasks/{task_id}` で、当該ユーザーのイベントに存在しない `task_id` は 404 と `not_found` を返す。403 を返さない。
- 応答は `timeline-response.schema.json` で検証してから返す。

**完了条件**
- [ ] `pnpm test:e2e -- e2e/tests/activity/incomplete-task.spec.ts` が緑で、終端未達の Task に5件のイベントがある状態で応答にどの `message` も含まれず `status` が `running` になる。
- [ ] 同 e2e で終端イベント到着後の呼び出しが6件を返すことを assert する。
- [ ] `pnpm test:e2e -- e2e/tests/activity/access-control.spec.ts` が緑で、user-A の Token で user-B の `task_id` を指定すると 404 になる。
- [ ] 同 e2e で `?human_subject=user-B` を付けても user-A のイベントしか返らないことを assert する。

### T-APP-25 横断閲覧と記録スイッチを作らないことを固定する

**概要**
複数ユーザーを横断する API と画面、および記録の開始停止スイッチを実装しない。
管理者ロールを名乗るクレームがあっても応答が変わらないことをテストで固定する。
RULE-56 と RULE-60 に対応する。

**対象要件** REQ-11-038, REQ-11-040
**前提タスク** T-APP-24
**成果物** `scripts/checks/no-recording-switch.sh`, `scripts/checks/no-cross-user-route.sh`, `e2e/tests/activity/no-cross-user-view.spec.ts`, `e2e/tests/activity/always-recording.spec.ts`, `docs/11-activity-timeline.md`（§8 への追記）

**実装方針**
- `scripts/checks/no-recording-switch.sh` は `apps/automation-app/src` のルート定義から `recording` / `demo-mode` / `capture` を含むパスを grep し、ヒットがあれば非ゼロ終了する。
- `scripts/checks/no-cross-user-route.sh` は同様に `admin` / `all-users` / `tenant` を含むパスと、`humanSubject` をパラメータから取る箇所を grep する。
- `require-user.ts` はトークン内の `role` / `groups` / `admin` クレームを読まない。読む処理を追加しない。
- 画面に記録の開始停止のトグルを置かない。
- docs 11 §8 に「全ユーザー横断の閲覧は今回の対象外とし、必要になった時点で閲覧用の権限モデルから設計する」を追記する。

**完了条件**
- [ ] `bash scripts/checks/no-recording-switch.sh` と `bash scripts/checks/no-cross-user-route.sh` がどちらも終了コード 0 を返す。
- [ ] `pnpm test:e2e -- e2e/tests/activity/no-cross-user-view.spec.ts` が緑で、`role: admin` を含む Token でも応答が変わらないことを assert する。
- [ ] `pnpm test:e2e -- e2e/tests/activity/always-recording.spec.ts` が緑で、何も操作せずに Agent を動かすだけで Activity Event が記録されることを確認する。

### T-APP-26 タイムライン一覧画面を実装する

**概要**
完了した Task を Agent ごとにグループ化して並べ、各行に目的と区分と終端 outcome と完了時刻を出す。
`provisioning` を先頭、`lifecycle` を末尾に固定し、実行中の Task はクリックできない行として出す。
DEC-APP-06 の Hono JSX SSR と vanilla TypeScript で作る。

**対象要件** REQ-11-021, REQ-11-028
**前提タスク** T-APP-24
**成果物** `apps/automation-app/src/ui/pages/timeline.tsx`, `apps/automation-app/src/ui/components/task-row.tsx`, `apps/automation-app/src/ui/components/agent-group.tsx`, `apps/automation-app/client/src/timeline.ts`, `e2e/tests/activity/timeline-list.spec.ts`, `e2e/tests/activity/list-grouping.spec.ts`

**実装方針**
- SSR は Hono JSX で行い、React と `react-dom` を依存へ追加しない。
- クライアント側は `apps/automation-app/client/src/timeline.ts` を esbuild で `public/timeline.js` へ束ねる。
- 並び順は、グループを終端 Agent の作成時刻の降順、グループ内を `provisioning` → `task-{n}`（終端イベントの `occurred_at` 昇順）→ `lifecycle` に固定する。
- `task-{n}` の並びは `n` の数値ではなく終端の `occurred_at` を基準にする。
- 各行の4列は `purpose`（Agent の目的）、`task_id`（区分）、`terminal_outcome`、`completed_at`。
- 行に `data-task-id` と `data-outcome` と `data-status` を付ける。
- 実行中の行は `<button disabled>` として描画し、`data-status="running"` を付け、クリックハンドラを登録しない。
- 一覧は画面を開いたときと更新ボタンを押したときの2回だけ `GET /api/activity/tasks` を呼ぶ。

**完了条件**
- [ ] `pnpm test:e2e -- e2e/tests/activity/timeline-list.spec.ts` が緑で、docs 11 §5.1 の4行の例が並び順と4列の内容ごと一致する。
- [ ] 同 e2e で実行中行のクリックが遷移も再生も起こさないことを assert する。
- [ ] `pnpm test:e2e -- e2e/tests/activity/list-grouping.spec.ts` が緑で、2体の Agent について DOM 上の順序が グループ順 × `[provisioning, task-1, task-2, lifecycle]` になる。

### T-APP-27 outcome と phase による強調表示を実装する

**概要**
`blocked` の行を `info` と `success` から見分けられる見た目にし、`phase=security` の `blocked` を `phase=tool_call` の `blocked` より強く強調する。
日常的な権限エラーが侵害と同じ見た目にならないようにする。
RULE-54 に対応する。

**対象要件** REQ-11-027
**前提タスク** T-APP-26
**成果物** `apps/automation-app/src/ui/styles/emphasis.css`, `apps/automation-app/src/ui/components/outcome-badge.tsx`, `e2e/tests/activity/emphasis.spec.ts`

**実装方針**
- 4種のクラスを `ev-info` / `ev-success` / `ev-blocked-tool` / `ev-blocked-security` に固定する。
- クラスの決定は `outcome` と `phase` の2値からの純関数 `emphasisClass(outcome, phase)` で行い、CSS 側で分岐しない。
- `ev-blocked-security` にだけ警告アイコンを付け、境界線を太くし、背景色をより強くする。
- アイコンはインライン SVG として同ファイルに置き、外部アイコンライブラリを追加しない。
- 色だけで区別しないため、4種すべてにテキストラベル（`情報` / `成功` / `遮断` / `遮断（セキュリティ）`）を併記する。
- 判定関数はイベント種別名を見ない。

**完了条件**
- [ ] `pnpm test:e2e -- e2e/tests/activity/emphasis.spec.ts` が緑で、4種の行が互いに異なる CSS クラスを持つ。
- [ ] `ev-blocked-security` の行だけが警告アイコン要素を持つことを assert する。
- [ ] `emphasisClass` の単体テストで、`(blocked, security)` と `(blocked, tool_call)` が異なる値を返すことを assert する。

### T-APP-28 detail の折りたたみ表示を実装する

**概要**
各イベントの `detail` を既定で折りたたみ、一覧の行からも再生後の結果表示からも開けるようにする。
再生を見ていない利用者でも Capability 一覧や Policy ID を確認できるようにする。
RULE-54 の「画面は判断せず表示するだけ」に沿う。

**対象要件** REQ-11-026
**前提タスク** T-APP-26
**成果物** `apps/automation-app/src/ui/components/detail-disclosure.tsx`, `apps/automation-app/client/src/detail-toggle.ts`, `e2e/tests/activity/detail-toggle.spec.ts`

**実装方針**
- `<details>` と `<summary>` を使い、初期状態で `open` 属性を付けない。
- `detail` の中身は `key` と値の2列テーブルとして描画し、値が配列なら要素を `、` で連結して1つの文字列にする。
- `detail` の値から文章を組み立てず、キー名をそのまま列見出しに使う（REQ-11-002）。
- 同じ `detail-disclosure` コンポーネントを一覧行と再生結果表示の両方から呼ぶ。専用の複製を作らない。
- 開閉状態を `localStorage` へ保存しない。
- `detail` が未定義のイベントでは `<details>` 自体を描画しない。

**完了条件**
- [ ] `pnpm test:e2e -- e2e/tests/activity/detail-toggle.spec.ts` が緑で、初期状態で detail が非表示であることを assert する。
- [ ] 同 e2e で、一覧行から開ける、再生を実行せずに開ける、再生後も開ける、の3点を assert する。
- [ ] `detail` を持たないイベントで `<details>` 要素が0個であることを assert する。

### T-APP-29 再生図の固定8ノード SVG を実装する

**概要**
再生の背景となる SVG を固定レイアウトの8ノードで作り、その Task に実際に現れたアプリだけを表示する。
グラフレイアウトの自動計算と Mermaid の動的生成を行わない。
DEC-APP-06 の「固定8ノードの静的 SVG」に対応する。

**対象要件** REQ-11-022
**前提タスク** T-APP-26
**成果物** `apps/automation-app/src/ui/components/replay-canvas.tsx`, `apps/automation-app/src/ui/replay/nodes.ts`, `apps/automation-app/test/replay-nodes.spec.ts`, `e2e/tests/activity/replay-nodes.spec.ts`

**実装方針**
- `nodes.ts` の `REPLAY_NODES` は `human-user`, `automation-app`, `authorization-platform`, `agent-provisioner`, `agent-op`, `agent-runtime`, `resource-as`, `resource-api` の8件を固定順で持つ。
- 座標は `viewBox="0 0 720 300"` の中に 2 行 4 列で固定する。上段が `human-user(80,60)`, `automation-app(260,60)`, `authorization-platform(440,60)`, `agent-provisioner(620,60)`、下段が `agent-op(80,220)`, `agent-runtime(260,220)`, `resource-as(440,220)`, `resource-api(620,220)`。
- `SOURCE_TO_NODE` は Activity Event の `source` を上の8 id へ写す。`lifecycle-manager` と `security-detection` は写像を持たず、この2つは「ノードを持たないイベント」として扱う。
- ノードを持たないイベントは矢印を描かず、SVG 中央の帯に `message` だけを出す（T-APP-30 で使う）。
- 表示するノードは、その Task のイベントの `source` と `detail.target` に現れた id の和集合とし、それ以外のノードには `hidden` 属性を付ける。
- 各ノードに `data-node="<id>"` を付ける。
- 座標計算をコード上で行わず、`nodes.ts` の定数テーブルにハードコードする。
- Mermaid とグラフレイアウトライブラリを依存へ追加しない。

**完了条件**
- [ ] `pnpm vitest run apps/automation-app/test/replay-nodes.spec.ts -t "8 nodes with fixed coordinates"` が緑で、`REPLAY_NODES` の要素数が8である。
- [ ] `pnpm test:e2e -- e2e/tests/activity/replay-nodes.spec.ts` が緑で、task-1 の再生に `data-node="authorization-platform"` が表示されず、provisioning Task では表示される。
- [ ] `apps/automation-app/package.json` の dependencies に `mermaid` と `d3` が無いことを確認する。

### T-APP-30 再生の進行制御を実装する

**概要**
Task のイベントを `occurred_at` 昇順に1件ずつ進め、到達時に `message` を表示する。
1ステップの長さを 800ms に固定し、実際の経過時間に比例させない。
再生し終えたら結果を静止させ、ループさせない。

**対象要件** REQ-11-023, REQ-11-025
**前提タスク** T-APP-29
**成果物** `apps/automation-app/client/src/replay.ts`, `apps/automation-app/client/src/replay-config.ts`, `apps/automation-app/src/ui/styles/replay.css`, `e2e/tests/activity/replay-order.spec.ts`, `e2e/tests/activity/replay-timing.spec.ts`

**実装方針**
- `replay-config.ts` に `export const REPLAY_STEP_MS = 800;` を1行だけ置き、ステップ長を参照する箇所をこの定数に限る。
- イベントは `occurred_at` の昇順に並べ、同値のときは `event_id` の昇順で決定的に並べる。
- 1ステップは、発生元ノードから宛先ノードへ向かう `<path>` 上を移動する `<circle>` の CSS アニメーション（`animation-duration: var(--step-ms)`、`animation-iteration-count: 1`、`animation-fill-mode: forwards`）で表現する。
- 宛先は `detail.target` から取り、無ければ `SOURCE_TO_NODE` の写像に従って直前のノードへ戻す。
- ステップ完了時に `message` を `data-step-index` 付きの要素として追記し、既存の `message` を消さない。
- `occurred_at` の差分を `setTimeout` の待ち時間に使わない。待ち時間は常に `REPLAY_STEP_MS`。
- 全ステップ終了後に `data-replay-state="finished"` を根要素へ付け、タイマーを解除する。再生を自動で再開する処理を書かない。
- ノードを持たないイベント（`lifecycle-manager` / `security-detection` 発）は矢印を描かず、`message` の表示だけで1ステップを消費する。

**完了条件**
- [ ] `pnpm test:e2e -- e2e/tests/activity/replay-order.spec.ts` が緑で、4イベントの Task で `message` が `occurred_at` 昇順に4回表示される。
- [ ] 同 e2e で再生終了後 5 秒経っても最終表示が残り、`data-replay-state` が `finished` のままであることを assert する。
- [ ] `pnpm test:e2e -- e2e/tests/activity/replay-timing.spec.ts` が緑で、`occurred_at` の間隔が3分と200ms の2ステップの表示間隔の差が 100ms 以内である。
- [ ] `grep -rn "REPLAY_STEP_MS" apps/automation-app` が定義1件と参照のみで、`800` のリテラルが他に無いことを確認する。

### T-APP-31 blocked のステップを宛先の手前で止める

**概要**
`outcome` が `blocked` のイベントは、動きを宛先ノードへ到達させず手前で停止させ、その位置で拒否理由を表示する。
docs 11 §5.2 の task-2 の例が動きで再現できるようにする。
RULE-54 に対応する。

**対象要件** REQ-11-024
**前提タスク** T-APP-30
**成果物** `apps/automation-app/client/src/replay.ts`（blocked 分岐の追加）, `apps/automation-app/src/ui/styles/replay.css`, `e2e/tests/activity/replay-blocked.spec.ts`

**実装方針**
- 停止位置は経路長の 60% に固定し、CSS カスタムプロパティ `--stop-ratio: 0.6` として1か所で定義する。
- `blocked` のステップでは `offset-distance` の終値を `calc(100% * var(--stop-ratio))` にし、`animation-fill-mode: forwards` で停止位置に留める。
- 停止した要素へ `data-blocked="true"` を付け、宛先ノードへ `data-reached="false"` を付ける。
- 拒否理由は当該イベントの `message` をそのまま表示し、画面側で理由文を組み立てない。
- 停止位置の見た目に停止アイコンを重ね、色は T-APP-27 の `ev-blocked-tool` と `ev-blocked-security` に合わせる。
- `blocked` の後続イベントがある場合も再生を続け、途中で打ち切らない。

**完了条件**
- [ ] `pnpm test:e2e -- e2e/tests/activity/replay-blocked.spec.ts` が緑で、動きを表す要素の最終 bounding box が宛先ノードの bounding box と交差しないことを assert する。
- [ ] 同 e2e で「許可された Tool に含まれない」を含む `message` が表示されることを assert する。
- [ ] `data-blocked="true"` の要素が1個、`data-reached="false"` の宛先ノードが1個であることを assert する。

### T-APP-32 is_simulated の Task にラベルを常時表示する

**概要**
台本イベントを含む Task には、一覧と再生と detail のすべてで「デモ実行（模擬）」を常時表示する。
折りたたみの内側に隠さず、実イベントと同じ見た目にしない。
RULE-58 に対応する。

**対象要件** REQ-11-029
**前提タスク** T-APP-26, T-APP-28, T-APP-30
**成果物** `apps/automation-app/src/ui/components/simulated-badge.tsx`, `apps/automation-app/src/ui/pages/timeline.tsx`（バッジ差し込み）, `e2e/tests/activity/simulated-label.spec.ts`

**実装方針**
- Task の `is_simulated` は、含まれるイベントのいずれかが `is_simulated === true` のときに真とする。
- バッジの文言は「デモ実行（模擬）」に固定し、`data-simulated="true"` を付ける。
- 表示位置は一覧行の先頭、再生キャンバスの右上、detail の `<summary>` の3か所とする。
- `<details>` の内側だけに置く実装をしない。
- 行の背景に斜線パターンを付け、実イベントの行と地の色を変える。
- `is_simulated` が偽の Task にバッジを描画しない。

**完了条件**
- [ ] `pnpm test:e2e -- e2e/tests/activity/simulated-label.spec.ts` が緑で、模擬 Task の一覧行と再生画面の両方に「デモ実行（模擬）」が表示される。
- [ ] 実 Task の行と再生画面に同文言が0件であることを assert する。
- [ ] `<details>` を閉じた状態でもバッジが可視であることを assert する。

### T-APP-33 フロントエンドの禁止依存を検査する

**概要**
タイムライン画面のビルド成果物に Firestore SDK を含めず、常時接続の配信経路も持たない。
Firestore Security Rules は作らず、ブラウザからの直接アクセス禁止をビルド成果物の検査で担保する。
DEC-IAC-10 と DEV-13 に対応する。

**対象要件** REQ-11-012, REQ-11-013
**前提タスク** T-APP-26, T-APP-30
**成果物** `scripts/checks/no-firestore-sdk-in-frontend.sh`, `scripts/checks/no-persistent-connection.sh`, `e2e/tests/activity/no-streaming.spec.ts`, `docs/deviations.md`（DEV-13 行のテストパス更新）

**実装方針**
- 検査対象は `apps/automation-app/public/*.js` の esbuild 出力とする。
- `no-firestore-sdk-in-frontend.sh` は `firebase`, `@firebase/firestore`, `firestore.googleapis.com` の3語を grep し、ヒットがあれば非ゼロ終了する。
- `no-persistent-connection.sh` は `new WebSocket`, `EventSource`, `onSnapshot` の3語を grep する。
- Firebase Auth を導入しないため、`apps/automation-app/package.json` に `firebase` 系の依存を入れない。
- REQ-11-012 の受入条件にある `allow read, write: if false;` の Security Rules は作らない。DEC-IAC-10 に従い、`google_firebaserules_*` リソースを Terraform に追加しない。
- `docs/deviations.md` の DEV-13 行の「固定するテスト」列を、上記2スクリプトのパスへ更新する。
- 更新のポーリングは、画面を開いたときと更新ボタンを押したときの2回だけにする。定期ポーリングの `setInterval` を書かない。

**完了条件**
- [ ] `bash scripts/checks/no-firestore-sdk-in-frontend.sh` と `bash scripts/checks/no-persistent-connection.sh` がどちらも終了コード 0 を返す。
- [ ] `pnpm test:e2e -- e2e/tests/activity/no-streaming.spec.ts` が緑で、画面を 60 秒開いても追加の HTTP リクエストが自動発生しない。
- [ ] `grep -rn "firebaserules" infra/` が0件であることを確認する。
- [ ] CI ジョブ `docs:deviations` が緑で、DEV-13 行の4列が埋まっている。

### T-APP-34 デモ専用画面と UI 側の判断ロジックを排除する

**概要**
通常利用時とデモ時を同じ画面と同じデータで実現し、デモ専用のルートとコンポーネントを作らない。
タイムライン関連のコードから、実行を止める処理と Risk Score の再計算と Finding の生成を排除する。
RULE-54 と RULE-60 に対応する。

**対象要件** REQ-11-037, REQ-11-039
**前提タスク** T-APP-26, T-APP-32
**成果物** `scripts/checks/no-demo-route.sh`, `eslint.config.js`（`no-restricted-imports` ルール追加）, `apps/automation-app/test/fixtures/ui-decision-violation.fixture.ts`, `e2e/tests/demo/same-screen.spec.ts`

**実装方針**
- `no-demo-route.sh` は `apps/automation-app/src` のルート定義から `/demo` で始まるパスを抽出し、`POST /api/demo/replay` 以外のヒットがあれば非ゼロ終了する。
- 台本再生のトリガーは一覧画面のボタン1個とし、専用ページを作らない。
- ESLint の `no-restricted-imports` で、`apps/automation-app/src/activity/**` と `apps/automation-app/src/ui/**` から `policy-engine` / `risk-scoring` / `lifecycle-manager` / `security-detection` を含むモジュールの import を禁止する。
- 画面から Lifecycle Manager と Security Detection の判定 API を呼ばない。`control-plane-client.ts` にその宛先を追加しない。
- 違反 fixture を1本置き、それを対象に含めた lint が失敗することを CI で確認する。

**完了条件**
- [ ] `bash scripts/checks/no-demo-route.sh` が終了コード 0 を返す。
- [ ] `pnpm lint` が緑で、`ui-decision-violation.fixture.ts` を lint 対象へ含めると失敗することを確認する。
- [ ] `pnpm test:e2e -- e2e/tests/demo/same-screen.spec.ts` が緑で、台本再生後のタイムラインが `GET /api/activity/tasks` から取得されることを assert する。

### T-APP-35 台本イベント注入 API を実装する

**概要**
実演が危険な4シナリオについて、あらかじめ用意した Activity Event 列をタイムラインへ直接書き込む。
API からイベント本文を渡させず、リポジトリ内の静的 JSON の4件だけを受け付ける。
DEC-DEMO-01 と RULE-58 に対応する。

**対象要件** REQ-11-034, REQ-11-035
**前提タスク** T-APP-23, T-APP-24, T-APP-20
**成果物** `apps/automation-app/src/demo/replay-routes.ts`, `apps/automation-app/src/demo/scenarios.ts`, `demo-scenarios/delegation-mismatch.json`, `demo-scenarios/signing-key-misuse.json`, `demo-scenarios/cross-agent-isolation.json`, `demo-scenarios/dpop-replay.json`, `e2e/tests/demo/scripted-injection.spec.ts`, `e2e/tests/demo/scripted-no-side-effect.spec.ts`, `scripts/checks/no-fake-actor-token.sh`

**実装方針**
- エンドポイントは `POST /api/demo/replay`、ボディは `{ scenario_id: string }` の1キーのみで `additionalProperties: false`。
- `scenarios.ts` は `ALLOWED_SCENARIOS = ['delegation-mismatch','signing-key-misuse','cross-agent-isolation','dpop-replay']` を持ち、この配列に無い値は 400 と `unknown_scenario` を返す。
- JSON の読み込みはビルド時に4ファイルを静的 import し、`scenario_id` からファイルパスを組み立てない。
- 各イベントは書き込み前にサーバ側で `is_simulated=true`、`human_subject`（コンテキストの `sub`）、`task_id='demo-{scenario_id}'` を必ず上書きする。ボディで別の値が来ても無視する。
- 書き込みは `users/{humanSubject}/activity/{event_id}` へ直接 create する。`publishActivityEvent` を呼ばない。
- Security Detection と Agent Runtime と Agent OP を呼ぶ処理を書かない。
- `no-fake-actor-token.sh` はリポジトリ全体で `agent-assertion+jwt` の署名生成が `apps/agent-runtime` 以外に現れないことを検査する。
- 4つの JSON は `packages/xaa-contracts` の Activity Event スキーマで検証できる形にし、CI で全件検証する。

**完了条件**
- [ ] `pnpm test:e2e -- e2e/tests/demo/scripted-injection.spec.ts` が緑で、4つの `scenario_id` が受理され5つ目が 400 になる。
- [ ] 同 e2e で、書き込まれたイベントが全て `is_simulated=true` であり、ボディで `human_subject` や `is_simulated=false` を渡しても無視されることを assert する。
- [ ] `pnpm test:e2e -- e2e/tests/demo/scripted-no-side-effect.spec.ts` が緑で、`agent-activity-stream` の publish 件数と `security_audit.findings` の行数がどちらも増えず、Agent の状態が変わらない。
- [ ] `bash scripts/checks/no-fake-actor-token.sh` が終了コード 0 を返す。
- [ ] CI ジョブ `demo:scenarios-schema` が4ファイルすべてのスキーマ検証に通る。

### T-APP-36 他ユーザーへの注入不能を negative test で固定する

**概要**
台本再生 API が操作者自身のセッション範囲に閉じることを、越境を試す4パターンで確認する。
Firestore の書き込みパスを Access Token の `sub` からのみ組み立てる実装をテストで固定する。
RULE-56 と RULE-58 に対応する。

**対象要件** REQ-11-036
**前提タスク** T-APP-35
**成果物** `e2e/tests/demo/no-cross-user-injection.spec.ts`, `apps/automation-app/test/demo-path-build.spec.ts`

**実装方針**
- 試す4パターンは、(1) ボディに `human_subject: 'user-B'` を含める、(2) `scenario_id` に `../user-B/activity` を含める、(3) `scenario_id` に URL エンコードしたパス区切りを含める、(4) クエリに `?human_subject=user-B` を付ける、とする。
- いずれも `users/user-B/activity` の件数が0件のままであることを assert する。
- (2) と (3) は `ALLOWED_SCENARIOS` の配列一致で弾かれるため 400 になる。パス正規化での防御に依存しない。
- 書き込みパスの組み立ては `demo/replay-routes.ts` の1関数 `buildActivityPath(humanSubject, eventId)` に集約し、引数を2つに限る。
- `buildActivityPath` の単体テストで、`humanSubject` に `/` を含む値を渡すと例外を投げることを確認する。

**完了条件**
- [ ] `pnpm test:e2e -- e2e/tests/demo/no-cross-user-injection.spec.ts` が緑で、4パターンすべてで `users/user-B/activity` に1件も書き込まれない。
- [ ] `pnpm vitest run apps/automation-app/test/demo-path-build.spec.ts -t "throws on slash in subject"` が緑になる。
- [ ] `buildActivityPath` 以外に `users/` を含むパス文字列の組み立てが `apps/automation-app/src/demo` に無いことを grep で確認する。

### T-APP-37 ログインから Provisioning 完了までの e2e を1本にまとめる

**概要**
docs 05 §2 の8手順と docs 07 §3.3 のシーケンスを、Playwright の1シナリオとして通す。
発行された各トークンの `aud` と `cnf.jkt`、Consent 復帰 URL のクエリ、最終状態の3点を機械的に確認する。
DEC-ID-13 と DEC-ID-19 の経路が実際に成立していることをここで固定する。

**対象要件** REQ-05-024, REQ-07-036
**前提タスク** T-APP-01, T-APP-09, T-APP-10, T-APP-22
**成果物** `e2e/tests/provisioning/provisioning-flow.spec.ts`, `e2e/src/helpers/token-assert.ts`, `e2e/src/helpers/firestore-assert.ts`

**実装方針**
- シナリオは、OIDC ログインと DPoP 鍵生成 → ID Token 取得 → `aud=authorization-platform` の DPoP-bound Access Token 取得 → Business Work Request 送信 → 検証 → `aud=agent-provisioner` の Access Token 取得 → Provisioning Request 送信 → 検証、の順で進める。
- 各トークンについて `audienceIncludes(aud, expected)` と `cnf.jkt` がクライアント鍵の RFC 7638 Thumbprint と一致することを assert する。
- Authorization Platform と Provisioner の双方が `human_subject === sub` を検証することを、`sub` を差し替えたリクエストが 401 になることで確認する。
- Provisioner が `IDP_CONSENT_REQUIRED` を返すことを assert する。
- `/xaa/callback` の後に `idp_connections` へ暗号化された Refresh Token と `expires_at` が作られることを Firestore で確認する。
- Automation App へ戻る URL のクエリパラメータ名の集合が `{transaction_id, code}` と完全一致することを assert する。部分一致で書かない。
- Resume 後に Agent Binding 作成、Agent Registration、Job Execution 起動を経て `status` が `ACTIVE` になることを Firestore で確認する。
- 途中で `sleep` を固定秒で挟まず、条件待ちで進める。

**完了条件**
- [ ] `pnpm test:e2e -- e2e/tests/provisioning/provisioning-flow.spec.ts` が緑になる。
- [ ] 復帰 URL のクエリ検査が `new Set([...params.keys()])` と `new Set(['transaction_id','code'])` の完全一致で書かれている。
- [ ] 最終状態として Firestore の Agent Registration の `status` が `ACTIVE` であることを assert する。
- [ ] 2種類の Access Token について `aud` と `cnf.jkt` の assert が合計4件あることを確認する。
