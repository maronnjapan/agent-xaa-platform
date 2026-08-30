# 08. Agent Runtime と Tool Executor（T-RUN）

Agent Runtime は Provisioning 済みの Agent を1体だけ動かす Cloud Run Job Execution である。
HTTP を listen せず、起動時に環境変数で渡された Tool Manifest と Agent Client Credential だけを入力に、LLM（Agent Reasoning）と Tool Executor を交互に回して作業を進める。
Tool Executor は同じイメージ内のモジュールであり、LLM が選んだ `tool_id` と `parameters` を受け取って、Agent OP への Token Exchange、Resource AS への ID-JAG 提示、Resource API 呼び出しまでを決定論的に実行する。
この領域が守る中心は「LLM は何をするかだけを決め、どこへどの資格で行くかは Manifest の値だけで決まる」という分離である。
実行中の追加指示、Checkpoint、構造化ログ、Activity Event の発行もこの領域が持つ。

| 前提 | 内容 |
|---|---|
| 依存する領域 | PROV（Tool Manifest と Agent Client Credential の受け渡し）、OP（`/xaa/token` と `/xaa/subject-token`）、RES（Resource AS と Resource API）、BRIDGE（P6 の外部 SaaS 経路）、IAC（Job 定義と SA のロール）、TEST（E2E とハーネス） |
| このファイルのタスク数 | 26件 |
| 主に満たす設計ルール | RULE-02, RULE-04, RULE-17, RULE-18, RULE-19, RULE-21, RULE-22, RULE-38 |

---

### T-RUN-01 Runtime のエントリポイントと起動パラメータ契約を実装する

**概要**
Agent Runtime を HTTP を listen しない素の Node エントリとして作り、Tool Executor を同じイメージ内のモジュールに閉じる。
起動パラメータの環境変数名が要件間で割れているため、`packages/xaa-contracts` に1組だけ定数として置き、Provisioner と Runtime の双方がそこから import する形にする。
人間のセッションに依存する値を起動パラメータへ入れないことを、起動時の禁止キー検査で強制する。
DEC-APP-02 の「Agent Runtime だけ HTTP を listen しない素の Node エントリ」に対応する。

**対象要件** REQ-01-008, REQ-04-016, REQ-08-042
**前提タスク** なし
**成果物**
- `apps/agent-runtime/package.json`
- `apps/agent-runtime/src/main.ts`
- `apps/agent-runtime/src/env.ts`
- `packages/xaa-contracts/src/runtime-env.ts`
- `packages/xaa-contracts/src/schemas/runtime-env.schema.json`
- `apps/agent-runtime/test/env.spec.ts`
- `apps/agent-runtime/test/no-http-listen.spec.ts`
- `infra/tests/no-runtime-service.sh`
- リポジトリ直下 `Dockerfile` の `APP=agent-runtime` 分岐

**実装方針**
- `main.ts` は `async function main(): Promise<number>` を1つだけ持ち、末尾で `process.exit(code)` を呼ぶ。`hono` と `@hono/node-server` を `apps/agent-runtime` の dependencies に入れない。
- `packages/xaa-contracts/src/runtime-env.ts` に `RUNTIME_ENV_KEYS` を定義する。値は `AGENT_ID` / `HUMAN_SUBJECT` / `TASK_ID` / `AGENT_CREATED_AT` / `AGENT_EXPIRES_AT` / `AGENT_OP_BASE_URL` / `TOOL_MANIFEST` / `TOOL_MANIFEST_SHA256` / `AGENT_CLIENT_PRIVATE_JWK` / `ISOLATION_LEVEL` / `SLOT_INDEX` / `VERTEX_MODE` / `VERTEX_MODEL` / `PUBSUB_MODE` / `STORE_MODE` / `ACTIVITY_TOPIC` / `GOOGLE_CLOUD_PROJECT` / `LOG_LEVEL` の18個とし、他の名前を Runtime と Provisioner のどちらにも書かない。
- `FORBIDDEN_ENV_KEYS` に `HUMAN_ACCESS_TOKEN` / `HUMAN_REFRESH_TOKEN` / `SESSION_ID` / `SUBJECT_TOKEN` / `CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` / `IDP_CONNECTION_ID` を置く。`loadEnv()` の先頭でこれらの存在を検査し、1つでもあれば `forbidden_env_key` をログへ出して exit code 78 で即終了する。
- `execution_id` は `CLOUD_RUN_EXECUTION`、タスク番号は `CLOUD_RUN_TASK_INDEX` から読む。未設定なら `local-<uuid>` を使い、この2つは `RUNTIME_ENV_KEYS` に含めない（Cloud Run が注入するため）。
- 終了コードを4値に固定する。`0` 完走、`10` Agent 期限超過、`20` 拒否を含む完了、`30` それ以外の失敗、`78` 起動パラメータ不正。
- Tool Executor は `apps/agent-runtime/src/tool-executor/index.ts` から `executeTool()` を named export するモジュールとし、HTTP ルート、Cloud Run Service 用の設定ファイル、`PORT` の読み取りを持たせない。

**完了条件**
- [ ] `pnpm --filter agent-runtime build` が成功し `apps/agent-runtime/dist/main.js` が生成される
- [ ] `rg -n "serve\(|\.listen\(|createServer" apps/agent-runtime/src` が0件
- [ ] `apps/agent-runtime/test/env.spec.ts::rejects forbidden env keys` が緑で、`HUMAN_ACCESS_TOKEN` を与えた起動が exit code 78 になる
- [ ] `infra/tests/no-runtime-service.sh` が緑（`google_cloud_run_v2_service` で name に `agent-runtime` を含む定義が0件）

---

### T-RUN-02 Execution Context と DPoP 鍵のメモリ生成を実装する

**概要**
Execution ごとに ES256 の DPoP 鍵ペアを1回だけメモリ上で生成し、Execution の終了とともに失わせる。
生成した鍵、取得したトークン、Manifest をまとめた ExecutionContext を1つ作り、以後のすべての処理はこのオブジェクト経由でのみ資格情報へ触れる。
トークン保管はプロセスメモリの Map 実装1つに限り、永続化の入口を型として作らない。
DEC-ID-12 と REQ-05-082 の「鍵の事前登録を行わない」に対応する。

**対象要件** REQ-05-082, REQ-05-090
**前提タスク** T-RUN-01
**成果物**
- `apps/agent-runtime/src/context/execution-context.ts`
- `apps/agent-runtime/src/tokens/token-store.ts`
- `apps/agent-runtime/test/execution-context.spec.ts`
- `apps/agent-runtime/test/token-store.spec.ts`

**実装方針**
- `createExecutionContext(env)` を `main.ts` から1回だけ呼ぶ。内部で `packages/xaa-crypto/src/dpop.ts` の `generateDpopKeyPair()` と `jwkThumbprint()` を使い、`{ privateKey: CryptoKey, publicJwk: JsonWebKey, jkt: string }` を作る。
- 秘密鍵は `extractable: false`、`usages: ['sign']` で生成する。`crypto.subtle.exportKey` が失敗することをテストで固定する。
- `ExecutionContext` の全フィールドを `readonly` にする。フィールドは `agentId` / `humanSubject` / `taskId` / `executionId` / `createdAt` / `expiresAt` / `manifest` / `dpop` / `agentClientKey` / `tokens` / `store` の11個とする。
- `TokenStore` は `Map<string, {value: string, expiresAt: number}>` の1実装のみを持ち、公開するのは `get` / `set` / `clear` の3メソッドとする。`save` / `persist` / `write` / `toJSON` を定義しない。キーは `subject`、`idjag:<tool_id>`、`at:<audience>|<resource>|<scope>` の3形式に限る。
- `get` は `expiresAt - 30_000` を過ぎたエントリを未取得として扱う。`main.ts` の `finally` で `tokens.clear()` を呼ぶ。
- `generateDpopKeyPair()` の呼び出しを `execution-context.ts` の1箇所に限定し、他モジュールからは `ctx.dpop` 経由でのみ参照させる。

**完了条件**
- [ ] `apps/agent-runtime/test/execution-context.spec.ts::generates exactly one dpop key per execution` が緑
- [ ] `apps/agent-runtime/test/execution-context.spec.ts::dpop private key is non-extractable` が緑
- [ ] `rg -n "generateDpopKeyPair" apps/agent-runtime/src` が1件
- [ ] `apps/agent-runtime/test/token-store.spec.ts::exposes only get/set/clear` が緑

---

### T-RUN-03 Runtime のクレデンシャル保持境界を型と構成で強制する

**概要**
Agent Client Credential の秘密鍵を Agent OP 向けの2用途に閉じ、Resource AS へ提示できない型にする。
Runtime が受け取ってはならない資格情報が env にもコードにも現れないことを、静的検査と Terraform のロール検査で固定する。
用途の限定をレビューではなく機械判定に落とすのがこのタスクの狙いである。
REQ-05-091 の「Runtime の SA に KMS 署名権限と Secret Manager 参照を付与しない」に対応する。

**対象要件** REQ-05-091, REQ-05-043
**前提タスク** T-RUN-02
**成果物**
- `apps/agent-runtime/src/context/agent-client-key.ts`
- `apps/agent-runtime/test/credential-boundary.spec.ts`
- `scripts/check-runtime-credentials.mjs`
- `infra/tests/runtime-sa-roles.sh`

**実装方針**
- `AGENT_CLIENT_PRIVATE_JWK` を起動時に1回だけ `crypto.subtle.importKey`（`extractable: false`、`usages: ['sign']`）へ通し、直後に `delete process.env.AGENT_CLIENT_PRIVATE_JWK` を実行する。JWK 文字列を他の変数へ代入しない。
- `AgentClientKey` 型が公開するのは `signCompactJws(header, payload): Promise<string>` の1メソッドのみとする。`toJSON()` は文字列 `[redacted]` を返す実装を明示的に置き、`JSON.stringify` で鍵情報が出ないようにする。
- 用途を actor_token の署名（T-RUN-09）と Agent OP 向け client_assertion の署名（T-RUN-09）の2つに限る。Resource AS と Resource API 向けのリクエスト組み立て関数は `AgentClientKey` を引数型に取らない。
- `scripts/check-runtime-credentials.mjs` が `apps/agent-runtime/src` を走査し、`refresh_token` / `client_secret` / `REFRESH_TOKEN` / `CLIENT_SECRET` / `idp_connections` / `secretmanager` / `metadata.google.internal` / `169.254.169.254` の出現を0件で要求する。非ゼロ終了で CI を落とす。
- `infra/tests/runtime-sa-roles.sh` が `sa-agent-runtime` と `sa-agent-slot-*` のロール集合を許可リスト（`roles/datastore.user`, `roles/run.invoker`, `roles/aiplatform.user`, `roles/pubsub.publisher`, `roles/logging.logWriter`）と完全一致で検査し、`roles/cloudkms.signerVerifier` と `roles/secretmanager.secretAccessor` の不在を要求する。

**完了条件**
- [ ] `apps/agent-runtime/test/credential-boundary.spec.ts::agent client key is not serializable` が緑（`JSON.stringify` の結果に `"d"` が現れない）
- [ ] `node scripts/check-runtime-credentials.mjs` が exit 0 で、禁止語を1つ足すと exit 1 になる
- [ ] `bash infra/tests/runtime-sa-roles.sh` が緑で、`roles/cloudkms.signerVerifier` を足した plan では失敗する
- [ ] `apps/agent-runtime/test/credential-boundary.spec.ts::resource request builder rejects agent client key` が型エラーとして固定されている

---

### T-RUN-04 Firestore パスガードを Runtime へ束ねる

**概要**
Firestore はドキュメント単位の IAM を持たないため、Runtime が触れてよいパスをアプリ側の許可マトリクスで固定する。
Runtime は自分の `agent_id` 配下の4パスだけを扱い、他 Agent の state や idp_connections へは到達させない。
`packages/gcp/src/firestore-guard.ts` の共通ラッパへ Runtime 用のマトリクスを渡す形にして、判定ロジックを二重に書かない。
DEV-05 の代替実装に対応する。

**対象要件** REQ-08-039
**前提タスク** T-RUN-01
**成果物**
- `apps/agent-runtime/src/store/runtime-store.ts`
- `apps/agent-runtime/test/runtime-store.spec.ts`

**実装方針**
- `createRuntimeStore({ app: 'agent-runtime', agentId })` を作り、内部で `packages/gcp/src/firestore-guard.ts` の `createFirestoreGuard()` を呼ぶ。Firestore クライアントを直接 export しない。
- 許可する操作を4件に固定する。`agents/{agentId}` の read、`agents/{agentId}/manifest` の read、`agents/{agentId}/instructions/{instruction_id}` の read と update、`agents/{agentId}/state` の write。
- `agentId` の一致判定は文字列の完全一致で行う。前方一致、正規表現、`startsWith` を使わない。
- 許可外の操作は `FirestorePathDenied`（`code: 'firestore_path_denied'`、`path` と `operation` を保持）を投げる。例外を握り潰して空配列を返す分岐を作らない。
- `users/{human_subject}/activity` への書き込み関数を Runtime に置かない。Activity Event は Pub/Sub 経由（T-RUN-25）のみとする。

**完了条件**
- [ ] `apps/agent-runtime/test/runtime-store.spec.ts::denies write to other agent state` が緑
- [ ] `apps/agent-runtime/test/runtime-store.spec.ts::denies read of idp_connections` が緑
- [ ] `apps/agent-runtime/test/runtime-store.spec.ts::allows exactly four operations` が table-driven で緑（許可表と実装の差分が0）
- [ ] `rg -n "new Firestore\(" apps/agent-runtime/src` が `runtime-store.ts` の1件のみ

---

### T-RUN-05 Checkpoint のスキーマとサニタイザを実装する

**概要**
Runtime が `agents/{agent_id}/state` へ書く Checkpoint のキーを6つに固定し、書き込み前に必ずサニタイザを通す。
秘密鍵素材が渡された場合は例外で止め、トークン形状の文字列はキーごと除去して警告ログを出す、という2段の挙動に分ける。
サニタイザを経由しない書き込み関数を export しないことで、経路の抜けを塞ぐ。
REQ-05-092 と REQ-07-019 が同じ書き込み口に別の要求を出しているため、1つの実装で両方を満たす。

**対象要件** REQ-07-019, REQ-05-092
**前提タスク** T-RUN-04
**成果物**
- `apps/agent-runtime/src/state/checkpoint-schema.json`
- `apps/agent-runtime/src/state/sanitize.ts`
- `apps/agent-runtime/src/state/checkpoint.ts`
- `apps/agent-runtime/test/checkpoint-sanitizer.spec.ts`

**実装方針**
- スキーマのトップレベルキーを `task_context` / `conversation_context` / `execution_state` / `pending_tool_calls` / `agent_status` / `updated_at` の6つに固定し、`additionalProperties: false` を付ける。検証は Ajv（strict モード）で行う。
- `sanitizeCheckpoint(value)` を再帰関数として実装する。キー名の denylist は `access_token` / `refresh_token` / `id_token` / `id_jag` / `assertion` / `client_assertion` / `client_secret` / `private_key` / `privateKey` / `d` / `jwk` / `dpop` とする。
- 値の形状判定は `/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/` に一致する文字列を JWT とみなす。
- 秘密鍵素材（`CryptoKey` インスタンス、`AgentClientKey` インスタンス、`d` を持つ JWK オブジェクト）を見つけたら `CheckpointSecretError` を投げる。トークン形状の文字列を見つけたときは該当キーを落として `checkpoint_sanitized`（`removed_keys` を含む）を warn で出す。この2つの挙動を混同しない。
- `writeCheckpoint(store, state)` だけを export し、内部で「Ajv 検証 → サニタイズ → `store` 経由の書き込み」の順に処理する。Firestore へ直接書く関数を export しない。
- DPoP 秘密鍵と Agent Client Credential の秘密鍵は `execution_state` に載せない。載せようとした場合は上の例外で止まる。

**完了条件**
- [ ] `apps/agent-runtime/test/checkpoint-sanitizer.spec.ts::throws on private key material` が緑
- [ ] `apps/agent-runtime/test/checkpoint-sanitizer.spec.ts::drops jwt-shaped values and warns` が緑
- [ ] `apps/agent-runtime/test/checkpoint-sanitizer.spec.ts::rejects unknown top-level key` が緑
- [ ] Firestore エミュレータへ実書き込みした内容を JWT 形状の正規表現でスキャンして0件

---

### T-RUN-06 Tool Manifest のスキーマとロード（step1）を実装する

**概要**
Tool Manifest の形を JSON Schema として `packages/xaa-contracts` に置き、Provisioner と Runtime が同じ定義を参照する。
Runtime は起動時に1回だけ Manifest を読み、sha256 を照合して凍結する。
実行中に Manifest を再取得する関数を持たないことで、追加指示による権限の書き換えを構造として不可能にする。
REQ-04-013 で Provisioner が生成する Manifest の受け側にあたる。

**対象要件** REQ-04-018
**前提タスク** T-RUN-01, T-PROV-10
**成果物**
- `packages/xaa-contracts/src/schemas/tool-manifest.schema.json`
- `packages/xaa-contracts/src/tool-manifest.ts`
- `apps/agent-runtime/src/manifest/load.ts`
- `apps/agent-runtime/test/manifest-load.spec.ts`

**実装方針**
- スキーマのトップレベルは `agent_id` / `expires_at` / `tools` の3キー。`tools[]` の要素は `tool_id` / `description` / `required_capability` / `authorization` / `token_provider` / `api` / `parameters` / `constraints` / `response_schema` とし、`response_schema` を required にする。
- `authorization` は `{ type: 'native_xaa' | 'xaa_bridge', audience: string, resource: string, scope: string }`。`api` は `{ base_url: string, method: 'GET' | 'POST' | 'PATCH', path: string }`。すべて `additionalProperties: false`。
- TypeScript 型は `json-schema-to-ts` で導出し、手書きの interface を並置しない。
- `loadToolManifest(env)` は `TOOL_MANIFEST` を `JSON.parse` し、Ajv で検証し、正規化前の生文字列の sha256（hex）を `TOOL_MANIFEST_SHA256` と比較する。不一致は `manifest_integrity_error` をログへ出して exit 30。
- `tool_id` は `packages/xaa-contracts` の `TOOL_IDS` 定数（`internal.document.list|get|create|update`、`internal.finance.payment.list|get|approve`、`stub.calendar.events.list`）に含まれる値だけを許可する。
- 読み込んだ Manifest を再帰的に `Object.freeze` し、`ctx.manifest` に置く。Firestore や Provisioner から Manifest を取り直す関数を実装しない。

**完了条件**
- [ ] `apps/agent-runtime/test/manifest-load.spec.ts::rejects sha256 mismatch` が緑（exit code 30）
- [ ] `apps/agent-runtime/test/manifest-load.spec.ts::rejects tool without response_schema` が緑
- [ ] `apps/agent-runtime/test/manifest-load.spec.ts::manifest is deeply frozen` が緑
- [ ] `rg -n "loadToolManifest" apps/agent-runtime/src` が定義1件と `main.ts` の呼び出し1件のみ

---

### T-RUN-07 Allowed Tools 判定（step2）と `tool_not_allowed` の返却を実装する

**概要**
Tool 実行の最初に、要求された `tool_id` が Manifest に含まれるかを完全一致で判定する。
含まれない場合は Agent OP を含むいかなる外部宛通信も行わずに拒否結果を返し、Checkpoint へ記録する。
この判定より前に HTTP クライアントへ触れるコードを置かないことをテストで固定する。
デモ D-1 が観測する「Agent OP と Finance API への呼び出しが0回」の実体はここである。

**対象要件** REQ-04-018, REQ-02-026
**前提タスク** T-RUN-05, T-RUN-06
**成果物**
- `apps/agent-runtime/src/tool-executor/index.ts`
- `apps/agent-runtime/src/tool-executor/steps/allowed-tools.ts`
- `apps/agent-runtime/src/tool-executor/errors.ts`
- `apps/agent-runtime/test/allowed-tools.spec.ts`

**実装方針**
- `executeTool(ctx, call: ToolCall): Promise<ToolResult>` の本体を step1 から step7 の順に並べ、step2 を `resolveAllowedTool(ctx.manifest, call.tool_id)` として最初の外部通信より前に置く。
- `resolveAllowedTool` は Manifest の `tools` から作った `Map<string, ToolDefinition>` を `get` で引く。ワイルドカード、前方一致、大文字小文字の正規化を行わない。
- 不一致時の戻り値を `{ outcome: 'blocked', reason: 'not_in_allowed_tools', error_code: 'tool_not_allowed', tool_id, stage: 'tool_selection' }` に固定する。例外を投げず、値として返す。
- `errors.ts` に Tool Executor のエラーコードを列挙する。`tool_not_allowed` / `agent_expired` / `missing_required_parameter` / `invalid_path_parameter` / `constraint_violation` / `agent_op_error` / `resource_as_error` / `bridge_error` / `resource_api_error` / `invalid_tool_call` / `unexpected_token_type` の11個とし、これ以外の文字列を outcome の理由に使わない。
- 拒否結果は `pending_tool_calls` へ追記して `writeCheckpoint`（T-RUN-05）を通す。Activity Event の発行は T-RUN-25 の `publishActivity` へ委譲する。
- Allowed Tools を実行中に追加、削除、置換する関数を実装しない。

**完了条件**
- [ ] `apps/agent-runtime/test/allowed-tools.spec.ts::returns tool_not_allowed without any http call` が緑（httpClient のスパイが0回）
- [ ] `apps/agent-runtime/test/allowed-tools.spec.ts::does not match by prefix or case` が緑
- [ ] Checkpoint に `reason: 'not_in_allowed_tools'` が残ることを Firestore エミュレータ上のテストで確認できる
- [ ] `rg -n "manifest.tools.push|manifest.tools =" apps/agent-runtime/src` が0件

---

### T-RUN-08 Agent Expiration 判定（step3）を実装する

**概要**
各 Tool 実行の直前に Manifest の `expires_at` と現在時刻を UTC で比較し、超過していれば Agent OP を呼ばずに終了する。
判定をキャッシュせず毎回行うことで、長時間の Reasoning の途中で期限を跨いだ場合も止まるようにする。
期限切れは権限判定による拒否とは別種の失敗として扱い、終端イベントの分類を混ぜない。
デモ D-3 が観測する3層のうち、Runtime 層がこのタスクにあたる。

**対象要件** REQ-04-019
**前提タスク** T-RUN-07
**成果物**
- `apps/agent-runtime/src/tool-executor/steps/expiration.ts`
- `apps/agent-runtime/test/expiration.spec.ts`

**実装方針**
- `assertNotExpired(nowMs: number, expiresAt: string)` を純関数として実装する。`expiresAt` は RFC 3339 の UTC 文字列とし、`Date.parse` の結果を数値比較する。`toLocaleString` や `getTimezoneOffset` を使わない。
- 超過時の戻り値は `{ outcome: 'failed', reason: 'agent_expired', error_code: 'agent_expired', stage: 'tool_selection' }` とする。`blocked` に分類しない（`blocked` は権限判定に由来するものだけに限る）。
- 期限超過を検出した時点で Reasoning ループを打ち切り、Runtime を exit code 10 で終了させる。残りの Tool 呼び出しを続けない。
- `AGENT_EXPIRED` の Activity Event は Lifecycle Manager が発行するため、Runtime からは出さない。Runtime が出す終端イベントは T-RUN-26 の判定に従う。
- 判定結果をメモ化せず、`executeTool` のたびに `Date.now()` を取り直す。

**完了条件**
- [ ] `apps/agent-runtime/test/expiration.spec.ts::stops before any agent op call when expired` が緑（httpClient のスパイが0回、exit code 10）
- [ ] `apps/agent-runtime/test/expiration.spec.ts::result is identical under TZ=UTC and TZ=Asia/Tokyo` が緑
- [ ] `apps/agent-runtime/test/expiration.spec.ts::re-evaluates on every tool call` が緑（1回目は成功、2回目は期限超過）
- [ ] `rg -n "AGENT_EXPIRED" apps/agent-runtime/src` が0件

---

### T-RUN-09 actor_token と client_assertion の生成を分けて実装する

**概要**
Agent Client Credential の鍵で署名する JWT は2種類あり、Token Exchange に添える actor_token と、Agent OP のクライアント認証に使う client_assertion である。
用途を取り違えられないよう、`typ` と有効期限と `jti` を分けた別々の関数として実装する。
`act.sub` の名前空間を `urn:xaa:agent:<agent_id>` に正規化し、Agent OP と同じ関数を共有する。
DEC-ID-10 と DEC-ID-11、および DEV-02 と DEV-03 に対応する。

**対象要件** REQ-05-066
**前提タスク** T-RUN-03
**成果物**
- `apps/agent-runtime/src/tokens/agent-assertion.ts`
- `apps/agent-runtime/src/tokens/client-assertion.ts`
- `packages/xaa-contracts/src/actor-token.ts`
- `apps/agent-runtime/test/agent-assertion.spec.ts`

**実装方針**
- `packages/xaa-contracts/src/actor-token.ts` に `toAgentUrn(agentId: string): string` を置く。すでに `urn:xaa:agent:` で始まる入力はそのまま返す冪等な実装にし、Agent OP 側の照合と同じ関数を使う。
- `buildActorToken(ctx)` のヘッダは `{ typ: 'agent-assertion+jwt', alg: 'ES256', kid: '<agent_id>-client-key' }`、ペイロードは `iss` と `sub` が `toAgentUrn(agentId)`、`aud` が `${AGENT_OP_BASE_URL}/xaa/token`、`exp` が `iat + 300`、`iat`、`jti` が 128bit 乱数の base64url。
- `aud` を issuer 文字列から組み立てない。direct プロファイルでは `/xaa/token` が issuer と別ホストにあるため、`AGENT_OP_BASE_URL` から作る（DEV-15）。
- `buildClientAssertion(ctx, path)` のヘッダは `{ typ: 'agent-client-auth+jwt', alg: 'ES256', kid: '<agent_id>-client-key' }`、`aud` は `${AGENT_OP_BASE_URL}${path}`、`exp` は `iat + 120`、`jti` は actor_token とは別に採番する。
- `typ` を引数で切り替える共通関数を作らない。2つの関数がそれぞれ自分の `typ` をリテラルで持つ。
- 署名は `ctx.agentClientKey.signCompactJws` のみを使う。KMS の `asymmetricSign` を Runtime から呼ばない。

**完了条件**
- [ ] `apps/agent-runtime/test/agent-assertion.spec.ts::header and payload match the fixed shape` が緑（`typ`、`kid`、`aud`、`exp - iat === 300` を assert）
- [ ] `apps/agent-runtime/test/agent-assertion.spec.ts::jti is 128bit and differs per call` が緑
- [ ] `apps/agent-runtime/test/agent-assertion.spec.ts::toAgentUrn is idempotent` が緑
- [ ] `rg -n "asymmetricSign|@google-cloud/kms" apps/agent-runtime` が0件

---

### T-RUN-10 subject_token の取得とメモリキャッシュを実装する

**概要**
Token Exchange に必要な人間の ID Token は、起動パラメータではなく Agent OP の `/xaa/subject-token` から取得する。
これにより Runtime は人間のブラウザセッションから完全に独立し、ログアウト後も作業を継続できる。
取得した ID Token だけをメモリへ置き、Refresh Token が応答に混ざっていたら失敗として扱う。
DEC-ID-19 と REQ-05-051 の受け側にあたる。

**対象要件** REQ-01-008
**前提タスク** T-RUN-02, T-RUN-09
**成果物**
- `apps/agent-runtime/src/tokens/subject-token.ts`
- `packages/xaa-contracts/src/client-assertion-type.ts`
- `apps/agent-runtime/test/subject-token.spec.ts`

**実装方針**
- `fetchSubjectToken(ctx)` は `POST ${AGENT_OP_BASE_URL}/xaa/subject-token` を1回だけ送る。ボディは `client_assertion`（T-RUN-09）と `client_assertion_type`（`packages/xaa-contracts/src/client-assertion-type.ts` の `AGENT_CLIENT_AUTH_ASSERTION_TYPE`）の2項目。
- DPoP Proof を `createDpopProof({ htm: 'POST', htu: '<上記URL>', key: ctx.dpop })` で作って `DPoP` ヘッダへ載せる。Access Token を伴わないため `ath` は付けない。
- 応答から取り出すのは `id_token` のみ。`refresh_token` または `access_token` のキーが応答に存在した場合は `unexpected_subject_response` で失敗させ、値をログにも Checkpoint にも残さない。
- 取得した ID Token を `TokenStore` の `subject` キーへ入れ、ペイロードの `exp` の60秒前を失効時刻とする。失効していれば Token Exchange の直前に再取得する。
- Human IdP へ Runtime から直接アクセスしない。到達先の許可リスト（T-RUN-21）に human-idp のホストを入れない。
- `SUBJECT_TOKEN` という環境変数を定義せず、起動パラメータから ID Token を受け取る経路を作らない。

**完了条件**
- [ ] `apps/agent-runtime/test/subject-token.spec.ts::fails when response contains refresh_token` が緑
- [ ] `apps/agent-runtime/test/subject-token.spec.ts::refetches when cached token is within 60s of exp` が緑
- [ ] `rg -n "human-idp|SUBJECT_TOKEN" apps/agent-runtime/src` が0件
- [ ] `apps/agent-runtime/test/subject-token.spec.ts::sends dpop proof without ath` が緑

---

### T-RUN-11 step4 の Token Exchange 要求を Manifest だけから組み立てる

**概要**
Agent OP の `/xaa/token` へ送るのは決められた9項目と DPoP ヘッダだけとし、値の出どころを Tool Manifest と Execution 内の状態に限定する。
LLM の応答オブジェクトを引数に取れない型にすることで、値の混入を実装段階で不可能にする。
リトライを行わないことで、`jti` の再利用と DPoP の再送を避ける。
REQ-05-064 の「LLM の出力を一切混ぜない」に対応する。

**対象要件** REQ-04-020, REQ-05-064
**前提タスク** T-RUN-09, T-RUN-10
**成果物**
- `apps/agent-runtime/src/tool-executor/steps/token-exchange.ts`
- `packages/xaa-contracts/src/grant-types.ts`
- `apps/agent-runtime/test/token-exchange.spec.ts`

**実装方針**
- `buildTokenExchangeBody(ctx, tool: ToolDefinition)` の引数を2つに固定する。`ToolCall`（LLM 由来）を引数に取らない。
- ボディのキーを9個に固定する。`grant_type` は `TOKEN_EXCHANGE_GRANT_TYPE`、`requested_token_type` は `ID_JAG_TOKEN_TYPE`、`subject_token_type` は `ID_TOKEN_TYPE`、`actor_token_type` は `JWT_TOKEN_TYPE`。いずれも `packages/xaa-contracts/src/grant-types.ts` から import し、文字列リテラルをアプリ側に書かない。
- `audience` / `resource` / `scope` は `tool.authorization` の3値をそのまま使う。連結、正規化、末尾スラッシュの補正を行わない。
- `subject_token` は `TokenStore` の `subject`、`actor_token` は `buildActorToken(ctx)` の戻り値を使う。
- DPoP Proof は `htm: 'POST'`、`htu: ${AGENT_OP_BASE_URL}/xaa/token` で毎回新規生成する。`ath` は付けない。
- 応答の `issued_token_type` が `ID_JAG_TOKEN_TYPE` でなければ `unexpected_token_type` で失敗させる。ID-JAG は `TokenStore` の `idjag:<tool_id>` へ入れ、ログに値を出さない。
- 4xx と 5xx のいずれもリトライしない。5xx は `agent_op_error` として返し、Bridge や別経路へ切り替えない。

**完了条件**
- [ ] `apps/agent-runtime/test/token-exchange.spec.ts::body has exactly nine keys` が緑
- [ ] `apps/agent-runtime/test/token-exchange.spec.ts::ignores llm-supplied api_base_url and scope` が緑（送信値が Manifest の値と一致）
- [ ] `apps/agent-runtime/test/token-exchange.spec.ts::does not retry on 5xx` が緑（リクエスト1回、`agent_op_error`）
- [ ] `apps/agent-runtime/test/token-exchange.spec.ts::sends dpop header` が緑

---

### T-RUN-12 step5 の Resource AS への ID-JAG 提示を実装する

**概要**
得た ID-JAG を Resource AS のトークンエンドポイントへ `jwt-bearer` で提示し、DPoP-bound な Access Token を得る。
クライアント認証は共有シークレットではなく `cnf.jkt` の PoP で行うため、`client_secret` を一切送らない。
取得した Access Token と ID-JAG はメモリのみに置き、Checkpoint とログへ出さない。
DEC-ID-14 と DEC-ID-15、および DEV-06 と DEV-11 に対応する。

**対象要件** REQ-04-021, REQ-05-083
**前提タスク** T-RUN-11
**成果物**
- `apps/agent-runtime/src/tool-executor/steps/redeem-id-jag.ts`
- `apps/agent-runtime/test/redeem-id-jag.spec.ts`

**実装方針**
- 宛先は `${tool.authorization.audience}/token` とする。`audience` は Resource AS の issuer（https URL）であるため、discovery を引かずにパスを連結する（DEV-09）。
- ボディは `grant_type` に `JWT_BEARER_GRANT_TYPE`、`assertion` に ID-JAG、`client_id` に `agent-platform` の3項目。`client_secret` と `Authorization: Basic` ヘッダを送らない。
- DPoP Proof は `htm: 'POST'`、`htu: '<上記の token endpoint>'` で新規生成し、Token Exchange で使ったものと同じ `ctx.dpop` の鍵を使う。`ath` は付けない。
- 応答の `token_type` が `DPoP` でなければ `unexpected_token_type` で失敗させる。`expires_in` から失効時刻を計算し、`TokenStore` の `at:<audience>|<resource>|<scope>` へ入れる。
- ログへ出してよいのは ID-JAG の `jti` と Access Token の失効時刻だけとする。トークン文字列そのものを引数に取るログ関数を作らない。
- 4xx はそのまま `resource_as_error` として返す。別の scope や audience で再試行しない。

**完了条件**
- [ ] `apps/agent-runtime/test/redeem-id-jag.spec.ts::sends no client_secret and no basic auth` が緑
- [ ] `apps/agent-runtime/test/redeem-id-jag.spec.ts::rejects non-DPoP token_type` が緑
- [ ] `apps/agent-runtime/test/redeem-id-jag.spec.ts::never logs token strings` が緑（ログ出力を JWT 形状の正規表現でスキャンして0件）
- [ ] `apps/agent-runtime/test/redeem-id-jag.spec.ts::does not retry with a different scope` が緑

---

### T-RUN-13 Native XAA で Bridge へフォールバックしない経路を固定する

**概要**
Tool の種別による経路選択を純関数へ切り出し、エラー時に別経路へ切り替える分岐を持たせない。
Resource AS が 5xx を返した場合も Bridge を試さず、そのままエラーを Reasoning へ返す。
これは実装の抜けを防ぐための構造上の固定であり、テストで経路の一意性を確認する。
RULE-21 と REQ-05-089 に対応する。

**対象要件** REQ-04-006, REQ-05-089
**前提タスク** T-RUN-12
**成果物**
- `apps/agent-runtime/src/tool-executor/steps/select-redeemer.ts`
- `apps/agent-runtime/test/select-redeemer.spec.ts`

**実装方針**
- `selectRedeemer(tool)` は `tool.authorization.type` が `native_xaa` なら `redeemIdJag`、`xaa_bridge` なら `redeemViaBridge` を返す純関数とする。それ以外の値は Manifest の検証（T-RUN-06）で落ちるため分岐を作らない。
- `try` / `catch` の中や HTTP ステータスの判定から別の redeemer を呼ぶコードを書かない。
- `native_xaa` の Tool に対して `tool.token_provider` を読まない。読む必要がある型定義にしない。
- Bridge のホストを `native_xaa` 経路の到達先許可リスト（T-RUN-21）に含めない。

**完了条件**
- [ ] `apps/agent-runtime/test/select-redeemer.spec.ts::returns one redeemer per type` が table-driven で緑
- [ ] `apps/agent-runtime/test/select-redeemer.spec.ts::resource as 500 does not call bridge` が緑（Bridge への呼び出し0回、`resource_as_error`）
- [ ] `rg -n "fallback|retryWithBridge|tryBridge" apps/agent-runtime/src` が0件

---

### T-RUN-14 Bridge 経路の step5 と外部 SaaS の直接呼び出しを実装する

**概要**
`xaa_bridge` の Tool では ID-JAG を Bridge へ提示して外部 SaaS の Access Token を得て、SaaS API は Tool Executor 自身が呼ぶ。
Bridge に業務 API を代理実行させる経路を作らないことで、Bridge の責務を Credential 交換に閉じる。
既定の `enable_google_bridge=false` では Bridge 種別の Tool が Manifest に現れないため、この経路はフェーズ P6 に置く。
REQ-04-005 と docs 06 §4 のシーケンスに対応する。

**対象要件** REQ-04-005
**前提タスク** T-RUN-13, T-BRIDGE-06
**成果物**
- `apps/agent-runtime/src/tool-executor/steps/redeem-via-bridge.ts`
- `apps/agent-runtime/test/redeem-via-bridge.spec.ts`

**実装方針**
- 宛先は `tool.token_provider` が指す Bridge の `/token` とする。ボディは `grant_type` に `JWT_BEARER_GRANT_TYPE`、`assertion` に ID-JAG、`resource` に `tool.authorization.resource` の3項目。
- Bridge へのリクエストは Access Token の取得1回のみとする。同じ Tool 実行の中で Bridge を2回呼ぶ経路を作らない。
- Bridge から得た外部 SaaS の Access Token は `Authorization: Bearer` で SaaS API へ送る。外向きの呼び出しに DPoP を付けない（DEC-ID-13）。
- SaaS API の URL は `tool.api.base_url` と `tool.api.path` から作る。Bridge の URL 配下へ SaaS のパスを付けて呼ぶコードを書かない。
- Bridge が 4xx と 5xx を返した場合は `bridge_error` を返し、Native 経路へ切り替えない。

**完了条件**
- [ ] `apps/agent-runtime/test/redeem-via-bridge.spec.ts::calls bridge exactly once` が緑
- [ ] `apps/agent-runtime/test/redeem-via-bridge.spec.ts::calls saas api from the executor with bearer` が緑
- [ ] `rg -n "bridge.*proxy|/bridge/proxy" apps/agent-runtime/src` が0件
- [ ] `enable_google_bridge=false` の Manifest では `xaa_bridge` の Tool が0件であることを `apps/agent-runtime/test/manifest-load.spec.ts` で確認できる

---

### T-RUN-15 Resource 宛の Authorization ヘッダ生成を1関数へ集約する

**概要**
Resource AS と Resource API へ送る認可ヘッダの生成を1つの関数に集め、その引数型に Service Account 由来のトークンを渡せないようにする。
GCP のメタデータサーバから取った ID Token が Resource へ流れる経路を、型と静的検査の両方で塞ぐ。
Access Token を伴う DPoP Proof には `ath` を必須にする。
REQ-01-015 と DEC-ID-12 に対応する。

**対象要件** REQ-01-015
**前提タスク** T-RUN-12
**成果物**
- `apps/agent-runtime/src/http/resource-authorization.ts`
- `apps/agent-runtime/src/http/internal-invoker-token.ts`
- `apps/agent-runtime/test/resource-authorization.spec.ts`

**実装方針**
- `ResourceAccessToken` を branded type（`string & { readonly __brand: 'resource-access-token' }`）として定義し、生成できるのは Resource AS と Bridge の応答パーサ（T-RUN-12 と T-RUN-14）だけとする。素の `string` からのキャスト用ヘルパを export しない。
- `buildResourceAuthorization(token: ResourceAccessToken, req: { method: string, url: string }, key: DpopKey)` が `{ Authorization: 'DPoP <token>', DPoP: '<proof>' }` を返す。Proof には `ath` として Access Token の SHA-256 を base64url で必ず入れる。
- Cloud Run の `run.invoker` 用 ID Token を取る処理は `internal-invoker-token.ts` に分け、戻り値の型を `InvokerIdToken` という別の branded type にする。この型は `buildResourceAuthorization` の引数として受け付けない。
- `google-auth-library` を `apps/agent-runtime` の依存に入れない。メタデータサーバへのアクセスは `internal-invoker-token.ts` の1箇所に閉じ、宛先は Agent OP と Bridge に限る。
- `scripts/check-runtime-credentials.mjs`（T-RUN-03）の禁止語検査に、`resource-authorization.ts` 以外での `Authorization: 'Bearer` の直書きを加える。

**完了条件**
- [ ] `apps/agent-runtime/test/resource-authorization.spec.ts::rejects plain string token` が型テストとして緑
- [ ] `apps/agent-runtime/test/resource-authorization.spec.ts::rejects invoker id token` が型テストとして緑
- [ ] `apps/agent-runtime/test/resource-authorization.spec.ts::proof includes ath of the access token` が緑
- [ ] `rg -n "metadata.google.internal|169.254.169.254" apps/agent-runtime/src` が `internal-invoker-token.ts` の1ファイルのみ

---

### T-RUN-16 step5.5 の constraint 検証を API 呼び出しの前に実装する

**概要**
Effective Capability に付いた constraint を、Tool Executor が外部通信の前に検証する。
Finance の `max_amount` と Mail の `recipient_domain_allowlist` が対象で、違反時は外部へ1件も出さずに `constraint_violation` を返す。
Resource API 側でも同じ値を検証する（T-RES 側）が、それを理由にここを省かない二重検証にする。
specs 5.2 の「constraint の二重検証」への回答にあたる。

**対象要件** REQ-04-022
**前提タスク** T-RUN-12
**成果物**
- `apps/agent-runtime/src/tool-executor/steps/verify-constraints.ts`
- `apps/agent-runtime/test/verify-constraints.spec.ts`

**実装方針**
- `verifyConstraints(tool, parameters)` を step5 の後、step6 の HTTP 送信の前に置く。Access Token 取得済みの状態でも、違反したら API を呼ばない。
- `max_amount` は `internal.finance.payment.approve` の対象金額を `parameters.amount`（最小単位の整数）から読み、`amount > max_amount` を違反とする。等値は許可する。
- `recipient_domain_allowlist` は宛先アドレスの `@` 以降を小文字化して完全一致で照合する。部分一致とサブドメインの暗黙許可を行わない。
- `constraints` が空オブジェクトまたは未定義の Tool は素通しする。未知の constraint キーがある場合は `constraint_violation` で止める（fail-closed）。
- 戻り値は `{ outcome: 'blocked', reason: 'constraint_violation', error_code: 'constraint_violation', constraint: '<キー名>' }` とし、違反した値そのものをログへ出さない。

**完了条件**
- [ ] `apps/agent-runtime/test/verify-constraints.spec.ts::over max_amount performs zero http calls` が緑
- [ ] `apps/agent-runtime/test/verify-constraints.spec.ts::equal to max_amount is allowed` が緑
- [ ] `apps/agent-runtime/test/verify-constraints.spec.ts::unknown constraint key is fail-closed` が緑
- [ ] `apps/agent-runtime/test/verify-constraints.spec.ts::tool without constraints passes through` が緑

---

### T-RUN-17 step6 の API Request 生成と実行を実装する

**概要**
Manifest の `api.base_url` と `api.path` からリクエスト URL を組み立て、`parameters` でプレースホルダを埋める。
必須パラメータの欠落、パス操作、Manifest に無いキーの3つを、外部へ出す前に潰す。
URL の組み立て後に base_url 配下から出ていないことを再検査する。
REQ-04-022 の受入条件が挙げる3ケースをそのままテストに落とす。

**対象要件** REQ-04-022
**前提タスク** T-RUN-15, T-RUN-16
**成果物**
- `apps/agent-runtime/src/tool-executor/steps/build-api-request.ts`
- `apps/agent-runtime/test/build-api-request.spec.ts`

**実装方針**
- `buildApiRequest(tool, parameters)` は次の順で処理する。required の充足検査、未定義キーの除去、プレースホルダ置換、URL 再検査、body と query の組み立て。
- `required: true` の parameter が欠けていれば `missing_required_parameter`（欠けたキー名を含む）を返し、HTTP を送らない。
- `path` の `{name}` は `encodeURIComponent(String(value))` で置換する。置換後に `new URL()` で正規化し、`url.origin + url.pathname` が `base_url` の `origin + pathname` で始まらなければ `invalid_path_parameter` を返す。
- Manifest の `parameters` に定義が無いキーは捨てる。捨てたことを `dropped_parameters` として stage ログ（T-RUN-24）へ出す。
- `GET` は残りの parameter を query string、`POST` と `PATCH` は JSON body にする。ヘッダは `buildResourceAuthorization`（T-RUN-15）の戻り値と `Content-Type: application/json` のみ。
- タイムアウトは `AbortController` で10秒。リトライを実装しない。

**完了条件**
- [ ] `apps/agent-runtime/test/build-api-request.spec.ts::missing required parameter performs zero http calls` が緑
- [ ] `apps/agent-runtime/test/build-api-request.spec.ts::traversal value stays under base_url` が緑（`primary/../../admin` を渡すケース）
- [ ] `apps/agent-runtime/test/build-api-request.spec.ts::unknown parameter is not sent` が緑
- [ ] `apps/agent-runtime/test/build-api-request.spec.ts::aborts after 10s and does not retry` が緑

---

### T-RUN-18 step7 の response_schema による allowlist 射影を実装する

**概要**
Resource API の応答をそのまま LLM へ渡さず、Tool ごとの `response_schema` に列挙されたフィールドだけを新しいオブジェクトへ写す。
除去ではなく写し取りにすることで、schema に無いフィールドが残る漏れを構造的になくす。
`response_schema` が無い Tool は Manifest のロード時点で落ちるため、この段では未定義を考慮しない。
REQ-04-023 と specs 5.1 の response_schema 列に対応する。

**対象要件** REQ-04-023
**前提タスク** T-RUN-17
**成果物**
- `apps/agent-runtime/src/tool-executor/steps/project-response.ts`
- `apps/agent-runtime/test/project-response.spec.ts`

**実装方針**
- `projectResponse(schema: string[], body: unknown)` を実装する。schema の要素は `document_id` と `items[].title` の2形式のみを受け付け、他の記法はロード時に落とす。
- 実装は「空のオブジェクトを作り、列挙されたパスの値だけをコピーする」方式にする。元オブジェクトに対する `delete` と `omit` を使わない。
- 配列は `items[]` の位置で要素ごとに再帰し、要素側でも列挙されたキーだけを写す。
- schema に無い階層へは探索に入らない。探索の深さは schema のパス長で決まる。
- 射影後の値を Conversation Context へ入れる。生の応答オブジェクトを Conversation Context と Checkpoint へ入れない。

**完了条件**
- [ ] `apps/agent-runtime/test/project-response.spec.ts::drops fields not in schema` が緑（`attendees[].email` が結果に現れない）
- [ ] `apps/agent-runtime/test/project-response.spec.ts::projected key set equals schema` が緑
- [ ] `apps/agent-runtime/test/project-response.spec.ts::projects each array element` が緑
- [ ] `rg -n "delete .*response|omit\(" apps/agent-runtime/src/tool-executor` が0件

---

### T-RUN-19 LLM 出力の切り詰めと Manifest 優先の値解決を実装する

**概要**
Agent Reasoning から受け取る値を `tool_id` と `parameters` の2つだけに切り詰める。
URL、method、audience、resource、scope、token 取得先が LLM の応答に含まれていても読まない。
`executeTool` の引数型を切り詰め後の `ToolCall` にすることで、生の応答を渡せないようにする。
RULE-18 の WHAT と HOW の分離をコードの型で表す。

**対象要件** REQ-04-017
**前提タスク** T-RUN-07
**成果物**
- `apps/agent-runtime/src/reasoning/parse-tool-call.ts`
- `apps/agent-runtime/test/parse-tool-call.spec.ts`

**実装方針**
- `parseToolCall(raw: unknown): ToolCall | InvalidToolCall` を実装する。`ToolCall` は `{ tool_id: string, parameters: Record<string, unknown> }` の2キーのみを持つ型とする。
- `raw` から取り出すのは `tool_id` と `parameters` だけとし、他のキーには触れない。スプレッド構文（`{ ...raw }`）を使わない。
- `tool_id` が文字列でない、または `parameters` がオブジェクトでない場合は `invalid_tool_call` を返す。
- `executeTool` の第2引数の型を `ToolCall` にする。`unknown` や LLM のレスポンス型を受け付けない。
- `call.url` / `call.scope` / `call.audience` / `call.resource` / `call.method` を参照するコードがソースに存在しないことを検査する。

**完了条件**
- [ ] `apps/agent-runtime/test/parse-tool-call.spec.ts::ignores api_base_url and scope in llm output` が緑（実行先が Manifest の `base_url`、Token Exchange の scope が Manifest の値）
- [ ] `apps/agent-runtime/test/parse-tool-call.spec.ts::rejects non-string tool_id` が緑
- [ ] `rg -n "call\.(url|scope|audience|resource|method|headers)" apps/agent-runtime/src` が0件
- [ ] `rg -n "\.\.\.raw|\.\.\.llm" apps/agent-runtime/src/reasoning` が0件

---

### T-RUN-20 Agent Reasoning ループと Tool 宣言の生成を実装する

**概要**
LLM へ提示する Tool の集合を Manifest の Allowed Tools と完全一致させ、汎用 HTTP Tool を1つも登録しない。
Vertex AI の呼び出しは共通クライアントを使い、`VERTEX_MODE=fake` で GCP に依存せずテストできるようにする。
ループの上限を設けて、終わらない Reasoning が Job の task_timeout まで走り続けないようにする。
REQ-04-024 の禁止事項と docs 04 §7 に対応する。

**対象要件** REQ-04-024
**前提タスク** T-RUN-19, T-APP の Vertex AI 共通クライアント（REQ-01-014）
**成果物**
- `apps/agent-runtime/src/reasoning/tool-declarations.ts`
- `apps/agent-runtime/src/reasoning/loop.ts`
- `apps/agent-runtime/test/tool-declarations.spec.ts`
- `apps/agent-runtime/test/reasoning-loop.spec.ts`

**実装方針**
- `buildToolDeclarations(manifest)` は `manifest.tools` から `{ name: tool_id, description, parameters }` を作る。宣言の追加、フィルタ、静的な補助 Tool の混入を行わない。
- `http_request` / `fetch` / `browse` / `shell` / `code_exec` / `eval` という名前の宣言を作らない。この5語をソース検索で0件にする。
- Vertex AI の呼び出しは共通クライアント（`VERTEX_MODE=fake|live`、モデル名は `VERTEX_MODEL`）経由とする。モデル名を `apps/agent-runtime` にハードコードしない。
- ループは `MAX_REASONING_STEPS`（既定8）で打ち切る。打ち切りは `outcome: 'failed'`、`reason: 'reasoning_step_limit'` として扱う。
- 各ステップの先頭で追加指示の読み取り（T-RUN-22）を呼ぶ。Conversation Context へ入れるのは射影済みの Tool 結果（T-RUN-18）と追加指示の本文のみとし、生の API 応答を入れない。
- ステップごとに `writeCheckpoint`（T-RUN-05）を呼ぶ。

**完了条件**
- [ ] `apps/agent-runtime/test/tool-declarations.spec.ts::declaration set equals allowed tools` が緑
- [ ] `rg -n "http_request|\"fetch\"|\"browse\"|\"shell\"|code_exec" apps/agent-runtime/src` が0件
- [ ] `apps/agent-runtime/test/reasoning-loop.spec.ts::stops at MAX_REASONING_STEPS` が緑
- [ ] `rg -n "gemini-" apps/agent-runtime/src` が0件

---

### T-RUN-21 動的な Tool と XAA 解決の不在を構成で固定する

**概要**
Runtime が Catalog、Registry、Discovery へ問い合わせて audience や scope を決める経路が無いことを、静的検査と到達先の許可リストの両方で固定する。
到達先は Agent OP、Resource AS 2種、Resource API 2種、Bridge、外部 SaaS、Vertex AI、Firestore に限る。
許可リストは起動時に凍結し、実行中に追加できないようにする。
REQ-04-015 と REQ-07-008 が同じ禁止事項を別の docs から述べているため、1つの実装で両方を満たす。

**対象要件** REQ-04-015, REQ-07-008
**前提タスク** T-RUN-06
**成果物**
- `apps/agent-runtime/src/http/allowed-hosts.ts`
- `apps/agent-runtime/src/http/http-client.ts`
- `scripts/check-no-dynamic-resolve.mjs`
- `apps/agent-runtime/test/allowed-hosts.spec.ts`

**実装方針**
- `buildAllowedHosts(env, manifest)` が到達先ホストの `Set<string>` を作る。要素は `AGENT_OP_BASE_URL` のホスト、Manifest の各 Tool の `authorization.audience` と `api.base_url` のホスト、Vertex AI のエンドポイント、Firestore のエンドポイントとする。
- 作った `Set` を `Object.freeze` し、`add` を呼ぶコードを置かない。実行中にホストを追加する関数を export しない。
- `httpClient` は送信前に宛先ホストを許可リストと照合し、外れていれば `HostNotAllowed` を投げる。DNS 解決の結果ではなく URL のホスト名で判定する。
- `scripts/check-no-dynamic-resolve.mjs` が `apps/agent-runtime/src` に `tool_catalog` / `registry` / `discovery` / `.well-known` / `cloudsql` の文字列が現れないことを検査する。
- Manifest 外の audience、resource、scope を引数に取る関数を export しない。export 一覧を突き合わせるテストを置く。

**完了条件**
- [ ] `node scripts/check-no-dynamic-resolve.mjs` が exit 0 で、`tool_catalog` を1つ足すと exit 1 になる
- [ ] `apps/agent-runtime/test/allowed-hosts.spec.ts::rejects request to a host outside the list` が緑
- [ ] `apps/agent-runtime/test/allowed-hosts.spec.ts::allowed host set is frozen` が緑
- [ ] `apps/agent-runtime/test/allowed-hosts.spec.ts::no exported function takes audience or scope` が緑

---

### T-RUN-22 追加指示の読み取りと `applied_at` 更新を同一トランザクションで実装する

**概要**
Reasoning の各ステップの前に、未適用の追加指示を Firestore から読んで Conversation Context へ入れる。
取得と `applied_at` の更新を同一トランザクションで行い、同じ指示が2回取り込まれないようにする。
Job が終了した後に更新が走らないよう、読み取りをループの内側に閉じる。
docs 02 §5 の「Agent Runtime が各ステップの前に読み取る」に対応する。

**対象要件** REQ-02-025
**前提タスク** T-RUN-04, T-RUN-20
**成果物**
- `apps/agent-runtime/src/instructions/read-pending.ts`
- `apps/agent-runtime/test/read-pending-instructions.spec.ts`

**実装方針**
- `readPendingInstructions(store, agentId)` は `runTransaction` の中で `agents/{agentId}/instructions` を `where('applied_at', '==', null)`、`orderBy('created_at', 'asc')` で読み、同じトランザクション内で各ドキュメントの `applied_at` に現在時刻を書く。
- トランザクション外で `applied_at` を更新する経路を作らない。読み取り専用の関数と更新専用の関数に分けない。
- 取得0件なら何も書かずにトランザクションを終える。
- 取り込んだ指示は Conversation Context に `{ role: 'user', source: 'instruction', instruction_id, body }` として追加し、`writeCheckpoint` で `conversation_context` に反映する。
- 呼び出しは `loop.ts` のステップ先頭の1箇所に限る。ループの外側と終了処理から呼ばない。
- 指示の本文を Tool の `parameters` へ直接流し込まない。必ず LLM の Reasoning を経由させる。

**完了条件**
- [ ] `apps/agent-runtime/test/read-pending-instructions.spec.ts::same instruction is not applied twice` が緑（連続2ステップで2回目は0件）
- [ ] `apps/agent-runtime/test/read-pending-instructions.spec.ts::concurrent readers do not double-apply` が Firestore エミュレータ上で緑
- [ ] `apps/agent-runtime/test/read-pending-instructions.spec.ts::no update outside transaction` が緑
- [ ] `rg -n "readPendingInstructions" apps/agent-runtime/src` が定義1件と `loop.ts` の呼び出し1件のみ

---

### T-RUN-23 権限外の追加指示を拒否し `rejected_instruction` を記録する

**概要**
追加指示によって Allowed Tools に無い Tool が必要になった場合も、同じ Tool Executor の step2 で拒否する。
拒否したことを `state.execution_state.rejected_instruction` に残し、Automation App の状況確認から見えるようにする。
Manifest の再取得と Provisioner への権限追加依頼という2つの経路を作らないことを、Manifest のハッシュ一致と到達先の不在で確認する。
RULE-13 の「既存 Agent の権限昇格を行わない」に対応する。

**対象要件** REQ-04-026, REQ-07-033
**前提タスク** T-RUN-07, T-RUN-22
**成果物**
- `apps/agent-runtime/src/instructions/record-rejection.ts`
- `apps/agent-runtime/test/instruction-guard.spec.ts`

**実装方針**
- 追加指示に由来する Tool 呼び出しも通常の Reasoning と同じ `executeTool` を通す。指示専用の実行経路を作らない。
- `blocked` かつ `reason === 'not_in_allowed_tools'` のとき、`execution_state.rejected_instruction` へ `{ instruction_id, requested_tool_id, reason: 'not_in_allowed_tools', rejected_at }` を配列として追記する。既存要素を上書きしない。
- Provisioner のホストを到達先許可リスト（T-RUN-21）に含めない。権限追加を依頼する関数を実装しない。
- Runtime の終了時に Manifest の sha256 を再計算し、起動時の値と一致することを `manifest_hash_stable` としてログへ出す。不一致なら exit 30。
- 拒否理由の文言は `title` と `message`（T-RUN-25）で人間向けに生成し、`detail.reason` にはコードをそのまま入れる。

**完了条件**
- [ ] `apps/agent-runtime/test/instruction-guard.spec.ts::out-of-permission instruction makes zero agent op calls` が緑
- [ ] `apps/agent-runtime/test/instruction-guard.spec.ts::records rejected_instruction in state` が緑
- [ ] `apps/agent-runtime/test/instruction-guard.spec.ts::manifest sha256 is identical before and after` が緑
- [ ] `rg -n "provisioner" apps/agent-runtime/src` が0件

---

### T-RUN-24 Tool 実行の段階構造化ログを実装する

**概要**
docs 04 §6 のフロー図の各遷移に対応する構造化ログを、1回の Tool 実行につき定義順に出す。
Agent Age と `expires_at` を毎回再計算して出すことで、Security Detection 側の Lifetime 系ルールの入力にする。
トークンと assertion の値がログへ出ないことを、出力直前のスキャンで機械的に保証する。
REQ-04-028 と REQ-09-013 が同じ出力先に別の項目を求めているため、1つのログ関数で両方を満たす。

**対象要件** REQ-04-028, REQ-09-013
**前提タスク** T-RUN-17
**成果物**
- `apps/agent-runtime/src/telemetry/stage-log.ts`
- `apps/agent-runtime/test/stage-log.spec.ts`

**実装方針**
- `STAGES` を9要素の配列として定義する。`agent_intent` / `tool_selection` / `required_capability` / `auth_mapping` / `agent_op` / `id_jag` / `token_endpoint` / `access_token` / `resource_api` の順に固定する。
- `emitStage(stage, fields)` は JSON 1行を stdout へ出す。共通フィールドは `execution_id` / `agent_id` / `task_id` / `tool_id` / `required_capability` / `audience` / `resource` / `scope` / `stage` / `outcome` / `operation` / `agent_age_seconds` / `expires_at` / `span_id` / `latency_ms` とする。
- `agent_age_seconds` は `Math.floor((Date.now() - createdAt) / 1000)` を出力のたびに計算する。キャッシュしない。
- `span_id` は Tool 実行ごとに 64bit 乱数の hex を採番し、同じ実行の9段で同じ値を使う。
- 出力の直前に、値が JWT 形状の正規表現に一致するフィールドを落として `log_sanitized: true` を立てる。`token` / `assertion` / `proof` という名前のフィールドを定義しない。
- `blocked` と `failed` のときは到達した段までを出し、以降の段を出さない。段の欠落は「そこで止まった」ことを表すため、埋め合わせのログを出さない。

**完了条件**
- [ ] `apps/agent-runtime/test/stage-log.spec.ts::emits stages in the fixed order` が緑
- [ ] `apps/agent-runtime/test/stage-log.spec.ts::every line has the nine runtime fields` が緑
- [ ] `apps/agent-runtime/test/stage-log.spec.ts::agent_age_seconds increases across three tool calls` が緑
- [ ] ログ全体を JWT 形状の正規表現でスキャンして0件

---

### T-RUN-25 Tool 系 Activity Event と `unauthorized_tool` の発行を実装する

**概要**
Tool の成功と拒否を Activity Event として Pub/Sub の `agent-activity-stream` へ publish する。
拒否のときは同時に Protocol Validation の `unauthorized_tool` を構造化ログへ出し、Security Detection の経路へ流す。
Activity と Security は別系統であるため、1つの関数から両方へ書く実装にしない。
docs 11 §3.1 の YAML 例と同じキー構成を固定する。

**対象要件** REQ-11-017, REQ-09-028
**前提タスク** T-RUN-07, T-RUN-24
**成果物**
- `apps/agent-runtime/src/telemetry/activity.ts`
- `apps/agent-runtime/src/telemetry/protocol-validation.ts`
- `packages/xaa-contracts/src/schemas/activity-event.schema.json`
- `apps/agent-runtime/test/activity-events.spec.ts`

**実装方針**
- Activity Event のキーを `event_id` / `trace_id` / `human_subject` / `agent_id` / `task_id` / `occurred_at` / `source` / `phase` / `outcome` / `title` / `message` / `detail` / `related_finding_id` / `is_simulated` の14個に固定し、Ajv で検証してから publish する。
- `source` は `agent-runtime` 固定。`is_simulated` は `false` を literal で書き、引数から受け取らない。
- `TOOL_SUCCEEDED` は `phase: 'tool_call'`、`outcome: 'success'`、`message` に `tool_id` を含める。`TOOL_BLOCKED` は `outcome: 'blocked'`、`detail` に `{ tool_id, effective_capabilities, reason }` を入れる。
- `effective_capabilities` は Manifest の各 Tool の `required_capability` を重複排除した配列とする。Firestore から取り直さない。
- `title` と `message` は Runtime 側で日本語の文面として組み立てる。画面側で組み立て直す前提の生データだけを送る形にしない。
- `PUBSUB_MODE=inproc` のときはメモリキューへ積み、`gcp` のときは `ACTIVITY_TOPIC` へ publish する。publish の失敗で Tool 実行を失敗させない（warn を出して続行）。
- `unauthorized_tool` は `protocol-validation.ts` から Cloud Logging 向けの構造化ログとして出す。Activity の publish 関数から呼ばない。

**完了条件**
- [ ] `apps/agent-runtime/test/activity-events.spec.ts::TOOL_BLOCKED matches the docs yaml key set` が緑
- [ ] `apps/agent-runtime/test/activity-events.spec.ts::emits one TOOL_BLOCKED and one unauthorized_tool per rejection` が緑
- [ ] `apps/agent-runtime/test/activity-events.spec.ts::is_simulated cannot be set to true` が緑（引数に受け取る口が無い）
- [ ] `apps/agent-runtime/test/activity-events.spec.ts::publish failure does not fail the tool call` が緑

---

### T-RUN-26 Task の終端イベントを判定して1件だけ発行する

**概要**
1回の指示に含まれる複数の Tool 呼び出しがすべて終わった時点で、Runtime が Task の結果を1つに判定する。
判定順は BLOCKED、FAILED、COMPLETED の順とし、拒否が1件でもあれば BLOCKED にする。
例外で落ちた場合も含め、1つの `task_id` につき終端イベントが必ず1件だけ出ることを保証する。
終端イベントが揃った Task だけがタイムラインの再生対象になるため（RULE-59）、抜けも重複も許されない。

**対象要件** REQ-11-010
**前提タスク** T-RUN-08, T-RUN-25
**成果物**
- `apps/agent-runtime/src/telemetry/task-outcome.ts`
- `apps/agent-runtime/test/task-outcome.spec.ts`

**実装方針**
- `decideTaskOutcome(results: ToolResult[]): 'TASK_BLOCKED' | 'TASK_FAILED' | 'TASK_COMPLETED'` を純関数として実装する。`blocked` が1件でもあれば `TASK_BLOCKED`、無くて `failed` があれば `TASK_FAILED`、全件 `success` なら `TASK_COMPLETED`。
- Tool 呼び出しが0件の Task は `TASK_COMPLETED` とする。
- `agent_expired`（T-RUN-08）と `reasoning_step_limit`（T-RUN-20）は `failed` に分類する。`blocked` は権限判定に由来する `not_in_allowed_tools` と `constraint_violation` だけに限る。
- `emitTerminalOnce(ctx, outcome)` にフラグを持たせ、2回目以降の呼び出しを無視する。`main.ts` の `finally` から必ず1回呼び、未発行なら例外時でも `TASK_FAILED` を出す。
- 終端イベントの `task_id` は `TASK_ID` の値をそのまま使う。Runtime 側で採番しない。

**完了条件**
- [ ] `apps/agent-runtime/test/task-outcome.spec.ts::all success maps to TASK_COMPLETED` が緑
- [ ] `apps/agent-runtime/test/task-outcome.spec.ts::one blocked among successes maps to TASK_BLOCKED` が緑
- [ ] `apps/agent-runtime/test/task-outcome.spec.ts::blocked wins over failed` が緑
- [ ] `apps/agent-runtime/test/task-outcome.spec.ts::emits exactly one terminal event even on throw` が緑

---

### T-RUN-27 Native XAA 経路4ステップの E2E を通す

**概要**
Human IdP のログインから Resource API の応答までを、実際の HTTP 経路で1本通す。
ID-JAG をスタブで作らず `/xaa/token` から取得することで、docs 05 §7 の Native XAA Runtime Flow が机上の設計ではなく動作する経路であることを確定させる。

**対象要件** REQ-01-023
**前提タスク** T-RUN-12, T-RUN-17, T-RES-23, T-OP-12
**成果物**
- `e2e/test/runtime/native-xaa-path.spec.ts`

**実装方針**
- `agent-op`、`human-idp`、`resource-docs-as`、`resource-docs-api`、`agent-runtime` の `createApp()` を1プロセスで結線する。
  DEC-TEST-01 のとおり、複数プロセスを起動しない。
- 経路は4ステップに固定する。
  (1) Human IdP へのログインで `aud=agent-platform` の ID Token を得る。
  (2) `/xaa/token` へ Token Exchange を送り ID-JAG を得る。
  (3) `resource-docs-as` へ `JWT_BEARER_GRANT_TYPE` 定数の grant で ID-JAG を提示し Access Token を得る。
  (4) `resource-docs-api` の `GET /documents` を Access Token で呼ぶ。
- ID-JAG をテスト内で組み立てない。
  必ず (2) の応答から取り出す。
- `globalThis.fetch` をスタブに差し替え、呼び出し回数を数える。
  すべての通信が `httpClient` 経由で対向アプリの `app.fetch` に届くため、スタブは0回でなければならない。

**完了条件**
- [ ] `pnpm test:e2e -- runtime/native-xaa-path` が緑になる。
- [ ] 同 spec 内で (4) の応答が 200 であることをアサートしている。
- [ ] 同 spec 内で `globalThis.fetch` のスタブ呼び出し回数が0であることをアサートしている。

---

### T-RUN-28 Runtime Flow 10手順を Document と Finance で1本ずつ通す

**概要**
docs 05 §7 の Runtime Flow を、STANDARD の Document 経路と FULL_ISOLATION の Finance 経路の両方で通す。
2経路を同じ手順で通すことで、Isolation Level の違いが経路の形ではなく設定と鍵の割り当てだけに現れることを示す。

**対象要件** REQ-05-093
**前提タスク** T-RUN-27, T-RUN-18, T-RES-19, T-RES-21
**成果物**
- `e2e/test/runtime/runtime-flow-docs.spec.ts`
- `e2e/test/runtime/runtime-flow-finance.spec.ts`

**実装方針**
- Finance 側は `isolation_level=full_isolation` で Provision し、スロットを1枠リースする。
- 各シナリオで6件をアサートする。
  ID-JAG の `sub` が委譲元の `human_subject` に一致すること。
  ID-JAG の `act.sub` が `urn:xaa:agent:<agent_id>` に一致すること。
  ID-JAG の `aud` が対象 Resource AS の issuer に一致すること。
  ID-JAG の `cnf.jkt` が Execution の DPoP 鍵の RFC 7638 thumbprint に一致すること。
  Access Token の `cnf` が同じ thumbprint を持つこと。
  Access Token の `act` が ID-JAG の `act` を引き継いでいること。
- 各シナリオの終了時にスロットを返却し、次のテストへ状態を持ち越さない。

**完了条件**
- [ ] `pnpm test:e2e -- runtime/runtime-flow-docs` が緑になる。
- [ ] `pnpm test:e2e -- runtime/runtime-flow-finance` が緑になる。
- [ ] 両 spec がそれぞれ6件のアサートを持つ。
- [ ] finance 側の spec で、`isolation_level` を `standard` に変えると 403 `insufficient_isolation` になることをアサートしている。

---

### T-RUN-29 プロンプトインジェクション拒否を実証する

**概要**
Resource 上のデータに仕込んだ指示文で Agent Reasoning を誘導しても、Allowed Tools の外へは1回も外部通信が出ないことを確かめる。
docs 04 §7 が主張する「Tool Executor の段階で拒否される」を、実際の経路で確定させる。

**対象要件** REQ-04-025
**前提タスク** T-RUN-07, T-RUN-18, T-RUN-27
**成果物**
- `e2e/test/runtime/prompt-injection.spec.ts`

**実装方針**
- Tool Manifest を `internal.document.list` と `internal.document.get` の2件に限る。
- `POST /documents` で、`body` に `internal.finance.payment.approve` の実行を促す文言を含むドキュメントを投入する。
- Agent Reasoning は `VERTEX_MODE=fake` とし、投入した文言に従って `internal.finance.payment.approve` を返すよう仕込む。
  誘導が成功した状態を作ったうえで、その先で止まることを見る。
- Tool Executor の戻り値が `{ outcome: 'blocked', reason: 'not_in_allowed_tools', error_code: 'tool_not_allowed' }` であることを確認する。
- `agent-op`、`resource-finance-as`、`resource-finance-api` の3アプリの `app.fetch` にカウンタを挟み、いずれも0回であることを確認する。

**完了条件**
- [ ] `pnpm test:e2e -- runtime/prompt-injection` が緑になる。
- [ ] Tool Executor の戻り値3フィールドをアサートしている。
- [ ] 3アプリの呼び出し回数がいずれも0であることをアサートしている。

---

### T-RUN-30 デモ D-1 を実操作の E2E として通す

**概要**
docs 11 §6.1 の D-1（権限外の操作が拒否される）を、通常の API とデータ経路だけで通す。
Firestore へ直接書く近道を作らず、ユーザーが画面から行う操作と同じ経路を踏む。

**対象要件** REQ-11-030
**前提タスク** T-RUN-23, T-RUN-25, T-RUN-26, T-APP-15, T-APP-31
**成果物**
- `e2e/test/demo/out-of-permission.spec.ts`

**実装方針**
- `document.read` だけを持つ Agent を Provision する。
- 追加指示は `POST /api/agents/{agent_id}/instructions` から入れる。
  Firestore の `agents/{agent_id}/instructions` へ直接書かない。
- 指示の内容は支払の承認を求めるものにする。
- `TOOL_BLOCKED` と `TASK_BLOCKED` の Activity Event が1件ずつ記録されることを確認する。
- タイムラインの再生 SVG で `data-blocked="true"` の要素が1個、宛先ノードの `data-reached` が `"false"` であることを確認する。
- D-2 は T-AUTHZ-31、D-3 は T-LIFE-17、D-4 は T-AUTHZ-32 が持つ。
  このタスクで4種すべてを書かない。

**完了条件**
- [ ] `pnpm test:e2e -- demo/out-of-permission` が緑になる。
- [ ] `TOOL_BLOCKED` と `TASK_BLOCKED` がそれぞれ1件であることをアサートしている。
- [ ] 再生 SVG の `data-blocked="true"` が1個であることをアサートしている。
- [ ] 宛先ノードの `data-reached` が `"false"` であることをアサートしている。

---

## このファイルで扱わない要件

次の1件は Bridge 経路の検証であり、`enable_google_bridge=true` のときだけ実行する。

| 要件ID | 内容 | 扱う領域とタスク |
|---|---|---|
| REQ-06-022 | Bridge Runtime Flow 14ステップの E2E | OAuth Bridge / T-BRIDGE-20 |
