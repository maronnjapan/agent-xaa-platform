# 07. 権限決定基盤（T-AUTHZ）

この領域は、人間ユーザーからの業務要求を受け取り、Agent へ実際に付与する権限（Effective Capability）と Isolation Level を決める Authorization Platform を作る。
内部は2つに分かれる。
Vertex AI で「その作業に必要そうな Capability」を推論する Authorization AI Agent と、推論結果を各種 Permission と Policy に照合して決定を下す Policy Engine である。
AI は提案しかせず、決定は必ず決定論的な Policy Engine が行う。
あわせて、Control Plane 3アプリ（Authorization Platform、Agent Provisioner、Lifecycle Manager）が共有する Access Token と DPoP Proof の検証ミドルウェアも、この領域が実装して他2アプリへ提供する。

| 前提 | 内容 |
|---|---|
| 依存する領域 | Identity（`packages/xaa-crypto` の DPoP と JWT 検証、Human IdP の JWKS）、Contracts（`packages/xaa-contracts` の Capability / scope 定数）、Infra（Firestore、Pub/Sub、Vertex AI、Cloud Run Job）、Lifecycle（Re-Provisioning の受け口）、Test（`e2e/harness` の同一プロセス結線） |
| このファイルのタスク数 | 32件 |
| 主に満たす設計ルール | RULE-09, RULE-10, RULE-11, RULE-12, RULE-43, RULE-44 |

このファイル全体で共通する取り決めを先に置く。

**アプリ**：`apps/authorization`（pnpm パッケージ名 `@xaa/authorization`、Cloud Run Service 名 `authorization`、Service Account `sa-authorization`、Access Token の audience 識別子 `authorization-platform`）。

**データストア**：Firestore（Native mode）1本（DEC-IAC-09）。docs と要件が「テーブル」「CHECK 制約」と書いている箇所は、同名の Firestore コレクションと、書き込み前の Ajv 検証および `packages/gcp/src/firestore-guard.ts` のパスガードへ読み替える（DEV-05）。

**テストの置き場**：単体と結線は `apps/authorization/test/**`、複数アプリをまたぐものは `e2e/test/authorization/**`。
要件の受入条件案にある `tests/unit/...` と `tests/e2e/specs/...` はこの規約へ正規化する。
`pnpm test:e2e` は `e2e/test/**` を vitest で実行する（DEC-APP-07 の同一プロセス結線）。ブラウザが要るものは扱わない。

**エラー応答**：`{ "error": "<code>", "error_description": "<固定文言>" }` の2キーのみを返す。スタックトレースと内部識別子を返さない。

---

### T-AUTHZ-01 Authorization Platform のアプリ骨格とルート表面を固定する

**概要**
`apps/authorization` を Hono アプリとして作り、`createApp(): Hono` を default export する。
同時に、このアプリが外へ見せるルートの集合とレスポンスの最上位キーを最初に固定し、Capability Taxonomy や Tool Catalog や Resource 一覧を返す経路を作れないようにする。
DEC-APP-02（Node 22 + Hono + ESM + tsc）と DEC-APP-07（`app.fetch` で結線するテスト）に対応する。

**対象要件** REQ-03-003
**前提タスク** なし
**成果物** `apps/authorization/package.json`, `apps/authorization/tsconfig.json`, `apps/authorization/src/app.ts`, `apps/authorization/src/server.ts`, `apps/authorization/src/config.ts`, `apps/authorization/src/errors.ts`, `apps/authorization/src/routes/index.ts`, `apps/authorization/src/routes/healthz.ts`, `packages/xaa-contracts/schemas/authorization-decision-response.schema.json`, `apps/authorization/test/routes-surface.test.ts`, `apps/authorization/test/decision-response-schema.test.ts`

**実装方針**
- `src/app.ts` は `export default function createApp(deps: AppDeps): Hono` とし、`deps` に store と pubsub と vertex と clock を引数で渡す。モジュールスコープで GCP クライアントを生成しない。
- `src/server.ts` は `@hono/node-server` の `serve` を呼ぶだけにする。ここに検証ロジックを書かない。
- `src/routes/index.ts` に `export const ROUTES` を置き、このアプリが登録する全ルートを `{ method, path, scope }` の配列として1か所で宣言する。`app.get` や `app.post` を `ROUTES` 以外の場所から直接呼ばない。
- 登録するルートは `GET /healthz`（無認証）、`POST /v1/authorization/decisions`、`POST /api/work-requests`、`POST /internal/events/human-permission-changed` の4本のみ。`/v1/authorization/decisions` を正とし、`/api/work-requests` は同じハンドラを別パスで登録した別名にする（リダイレクトにしない）。
- `GET /v1/capabilities`、`GET /v1/taxonomy`、`GET /v1/tools`、`GET /v1/resources` に相当するルートを作らない。
- `packages/xaa-contracts/schemas/authorization-decision-response.schema.json` を `additionalProperties: false` で定義し、最上位キーを `decision_id` / `status` / `effective_capabilities` / `security_profile` / `denied` の5件に固定する。`status` の許可値は `decided` と `no_capability_inferred` の2値（REQ-03-006 が要求する状態をレスポンスで表すためのフィールドであり、Taxonomy や Resource の列挙には使わない）。
- `src/config.ts` は環境変数を1か所で読む。`PORT` / `ISSUER` / `JWKS_URL` / `AUTHZ_AUDIENCE` / `PROJECT_ID` / `REGION` / `STORE_MODE` / `PUBSUB_MODE` / `VERTEX_MODE` / `VERTEX_MODEL` / `VERTEX_LOCATION` / `DPOP_IAT_SKEW_SECONDS` / `DPOP_JTI_TTL_SECONDS` / `LIFECYCLE_BASE_URL` / `ACTIVITY_TOPIC` / `TAXONOMY_VERSION`。未設定時に既定値へ落とさず起動時に例外を投げる（既定値を許すのは `DPOP_IAT_SKEW_SECONDS=60` と `DPOP_JTI_TTL_SECONDS=120` のみ）。

**完了条件**
- [ ] `pnpm --filter @xaa/authorization build` が成功し、`dist/server.js` が生成される。
- [ ] `apps/authorization/test/routes-surface.test.ts` が `ROUTES` を列挙し、`method === 'GET'` かつ `path !== '/healthz'` のルートが0件であることを assert して green。
- [ ] `apps/authorization/test/decision-response-schema.test.ts` が、`decision_id` / `status` / `effective_capabilities` / `security_profile` / `denied` 以外のキーを持つオブジェクトを Ajv が reject することを assert して green。
- [ ] `ISSUER` を未設定にして `createApp` を呼ぶと例外が投げられるテストが green。

---

### T-AUTHZ-02 権限ドメインの Firestore コレクションとスキーマを定義する

**概要**
Work Definition（何をするか）、Capability（何が許されるか）、Tool（どう実行するか）を別コレクションに分け、相互の関連を中間コレクションで表す。
あわせて Isolation Level を2値の列挙として1か所に定義し、API 層とストア層の両方で第3の値を拒否する。
RULE-15 と RULE-30 に対応し、docs の Cloud SQL 前提を DEC-IAC-09 の Firestore へ読み替える。

**対象要件** REQ-01-006, REQ-01-019
**前提タスク** T-AUTHZ-01
**成果物** `packages/xaa-contracts/src/isolation.ts`, `packages/xaa-contracts/schemas/work-definition.schema.json`, `packages/xaa-contracts/schemas/capability.schema.json`, `packages/xaa-contracts/schemas/capability-taxonomy.schema.json`, `apps/authorization/src/store/collections.ts`, `apps/authorization/src/store/authorization-store.ts`, `apps/authorization/test/schema-separation.test.ts`, `apps/authorization/test/isolation-level.test.ts`

**実装方針**
- `src/store/collections.ts` にコレクション名とドキュメント ID の組み立て規則を定数で置く。他のファイルで文字列リテラルのコレクション名を書かない。
  - `work_definitions/{work_definition_id}`：`purpose`, `description`, `operations[]`, `target_resources[]`, `constraints`, `human_subject`, `created_at`
  - `capabilities/{capability_id}`：`capability_id`, `resource`, `object`, `action`, `description`, `default_characteristics`
  - `capability_taxonomy/{taxonomy_version}`：`version`, `capability_ids[]`, `published_at`
  - `tool_catalog/{tool_id}`：Tool / Connector Catalog 領域が正本。この領域は読み取りのみで、書き込み関数を実装しない。
  - `agent_capability_grants/{work_definition_id}__{capability_id}`
  - `agent_tool_grants/{agent_id}__{tool_id}`
- `work_definitions` のスキーマは `additionalProperties: false` とし、プロパティ名に `capability` / `tool` / `endpoint` / `scope` / `url` / `method` を含む名前を1つも置かない。
- `packages/xaa-contracts/src/isolation.ts` に `export const ISOLATION_LEVELS = ['standard', 'full_isolation'] as const` と `export type IsolationLevel = (typeof ISOLATION_LEVELS)[number]`、比較関数 `maxIsolationLevel(a, b)`（`standard < full_isolation`）、検証関数 `assertIsolationLevel(v): asserts v is IsolationLevel` を置く。
- `assertIsolationLevel` は API 層（400 `invalid_request`）とストア層（例外を投げて書き込みを行わない）の両方から呼ぶ。CHECK 制約の代替はこのストア層の検証である。
- `IsolationLevel` を `string` へ広げる型注釈と、`partial` のような第3の値を受ける分岐を書かない。

**完了条件**
- [ ] `apps/authorization/test/schema-separation.test.ts` が `work-definition.schema.json` の全プロパティ名に対し `/(capability|tool|endpoint|scope|url|method)/i` が1件も一致しないことを assert して green。
- [ ] `apps/authorization/test/isolation-level.test.ts` が `isolation_level: "partial"` を含む Security Profile で Ajv が 400 相当の検証失敗を返し、同じ値でストアの書き込み関数が例外を投げて Firestore への書き込みが0回であることを assert して green。
- [ ] `grep -rn "collection('" apps/authorization/src | grep -v store/collections.ts` の結果が0件。
- [ ] `pnpm --filter @xaa/authorization test schema-separation isolation-level` が green。

---

### T-AUTHZ-03 ポリシーデータの投入ジョブと Human Permission 変更 CLI を作る

**概要**
Capability Taxonomy と各種 Policy の初期値を repo 内 YAML に置き、Cloud Run Job から Firestore へ投入する。
投入時に Capability ID の命名規約（DEC-SCOPE-03）を全行検査し、違反があれば非ゼロ終了する。
あわせて Human Permission の変更を模擬する CLI を作り、変更を Pub/Sub トピック `human-permission-changed` へ publish する。

**対象要件** REQ-03-010
**前提タスク** T-AUTHZ-02
**成果物** `apps/authorization/policy-data/manifest.yaml`, `apps/authorization/policy-data/capability-taxonomy.yaml`, `apps/authorization/policy-data/human-permission.yaml`, `apps/authorization/src/seed/seed.ts`, `apps/authorization/src/seed/validate-naming.ts`, `scripts/perm-set.ts`, `apps/authorization/test/seed-naming.test.ts`, `apps/authorization/test/perm-set.test.ts`

**実装方針**
- `manifest.yaml` は `{ file, collection, schema, id_field }` の配列にする。以降のタスクが追加する YAML はこの配列へ1行足すだけで投入対象になる。seed 本体に個別ファイル名を書かない。
- `capability-taxonomy.yaml` に確定8件（`calendar.event.read` / `calendar.event.write` / `mail.message.read` / `mail.message.send` / `document.read` / `document.write` / `finance.payment.read` / `finance.payment.approve`）を置き、各行に `resource`（`calendar` / `mail` / `document` / `finance`）と `description` と `default_characteristics` を持たせる。
- `human-permission.yaml` に `user-123` = `calendar.event.read` / `calendar.event.write` / `mail.message.read` / `mail.message.send`、`user-456` = `finance.payment.read` / `finance.payment.approve` / `document.read` / `document.write` を置く。投入先は `human_permissions/{human_subject}__{capability_id}` の1行1ドキュメント形式にする。行の削除で権限剥奪を表すためであり、配列フィールドにまとめない。
- `validate-naming.ts` は `^[a-z]+(\.[a-z_]+){1,2}$` に一致すること、`google` / `microsoft` / `github` / `slack` を含まないこと、`get` / `post` / `put` / `patch` / `delete` をセグメント全体として含まないことを検査する。1件でも違反したら違反行をすべて標準エラーへ出したうえで `process.exit(1)` する。
- seed は冪等にする。同じ入力で2回流しても Firestore のドキュメント数と内容が変わらないよう `set`（merge なし）で書く。
- `scripts/perm-set.ts` は `pnpm perm:set <subject> <capability> <grant|revoke>` で起動する。`grant` は該当ドキュメントを作成、`revoke` は削除する。どちらも実行後に `human-permission-changed` へ `{ human_subject, capability_id, action, changed_at }` を publish する（`changed_at` は RFC 3339 の UTC 文字列）。REQ-07-027 の受信側は `human_subject` と `changed_at` だけを必須とする。
- Pub/Sub は `PUBSUB_MODE=inproc|gcp` で差し替える（DEC-APP-09）。CLI から Terraform コマンドを呼ばない。

**完了条件**
- [ ] `apps/authorization/test/seed-naming.test.ts` が `google.calendar.read` と `document.GET` を含む YAML に対し `validate-naming` が非ゼロ終了コードを返し、違反2件を出力することを assert して green。
- [ ] seed ジョブを同一入力で2回実行したあと、`capabilities` の件数が8、`human_permissions` の件数が8であることを Firestore エミュレータに対する結線テストで確認できる。
- [ ] `apps/authorization/test/perm-set.test.ts` が `perm:set user-123 calendar.event.read revoke` で該当ドキュメントが消え、inproc Pub/Sub に1件のメッセージが積まれることを assert して green。
- [ ] `perm:set` の引数に未知の action を渡すと非ゼロ終了し、Firestore への書き込みと publish がどちらも0回であることを assert して green。

---

### T-AUTHZ-04 AI 提案と Policy 決定を別レコードとして保存する

**概要**
Authorization AI Agent の出力と Policy Engine の決定を、別コレクションへ別レコードとして保存する。
`effective_capabilities` の読み出し経路を `authorization_decisions` に限定し、`ai_proposals` から直接読む関数をコード上に作らない。
RULE-10 と DEC-SCOPE-05 に対応する。

**対象要件** REQ-01-007
**前提タスク** T-AUTHZ-02
**成果物** `apps/authorization/src/store/proposal-store.ts`, `apps/authorization/src/store/decision-store.ts`, `apps/authorization/src/store/collections.ts`（追記）, `apps/authorization/test/proposal-decision-separation.test.ts`

**実装方針**
- コレクションを2本足す。`ai_proposals/{proposal_id}`（`decision_id`, `work_definition_id`, `proposed_capabilities[]`, `characteristics`, `confidence`, `taxonomy_version`, `model_version`, `created_at`）と `authorization_decisions/{decision_id}`（`human_subject`, `work_definition_id`, `proposal_id`, `status`, `effective_capabilities[]`, `security_profile`, `denied[]`, `created_at`）。
- `proposal-store.ts` は `saveProposal` と `getProposalByDecisionId` の2関数のみを export する。`getProposalByDecisionId` の戻り値の型に `effective_capabilities` を含めない。
- `decision-store.ts` は `saveDecision` と `getDecision` と `listActiveDecisionsBySubject` を export する。API 応答と Activity Event の `effective_capabilities` は必ずここから読む。
- `ai_proposals` を読む import を持ってよいのは Policy Engine への入力を組み立てる `src/pipeline/` と再評価の `src/reevaluate/` だけとし、`src/routes/` から `proposal-store` を import しない。
- 保存順序は proposal を先、decision を後にする。decision の保存に失敗した場合は API を 500 とし、`effective_capabilities` を含む応答を返さない。

**完了条件**
- [ ] `apps/authorization/test/proposal-decision-separation.test.ts` が、AI が Taxonomy 外の `slack.channel.admin` を提案したケースで `ai_proposals` には当該値が残り、API 応答の `effective_capabilities` には現れないことを assert して green。
- [ ] `grep -rn "proposal-store" apps/authorization/src/routes` の結果が0件。
- [ ] decision 保存を失敗させたテストで、API が 500 を返し `effective_capabilities` を含まない応答本文になることを assert して green。

---

### T-AUTHZ-05 Access Token 基本検証ミドルウェアを実装する

**概要**
Control Plane 3アプリが共有する `packages/control-plane-auth` を作り、docs 05 §2.1 の手順1から3に当たる Access Token 検証を実装する。
署名と `iss` と `exp` に加え、DEC-ID-18 の `typ` 検査と、ID Token を Access Token として受理しないガードをここに置く。
`aud` の判定は DEV-12 に従い配列要素の完全一致で行う。

**対象要件** REQ-05-010, REQ-05-019, REQ-02-012
**前提タスク** T-AUTHZ-01
**成果物** `packages/control-plane-auth/package.json`, `packages/control-plane-auth/src/access-token.ts`, `packages/control-plane-auth/src/jwks-cache.ts`, `packages/xaa-contracts/src/audience.ts`, `packages/control-plane-auth/test/access-token.spec.ts`

**実装方針**
- `accessTokenMiddleware(options: { issuer, jwksUrl, audience, requiredScope })` を export する。`audience` は `authorization-platform` / `agent-provisioner` / `lifecycle-manager` のいずれかを呼び出し側が渡す。
- 検証順序を次に固定する。(1) `Authorization: DPoP <token>` の形式（`Bearer` は 401 `invalid_token`）、(2) 署名（JWKS を `jwksUrl` から取得、`kid` で選択）、(3) JOSE ヘッダ `typ === 'at+jwt'`、(4) `iss === options.issuer`、(5) `exp` と `nbf`、(6) `aud` 要素一致、(7) `scope`。
- (3) で `typ` が `at+jwt` 以外の場合は 401 `invalid_token`。`nonce` または `at_hash` を持つペイロードも同じく 401 `invalid_token` とし、ID Token を受理する分岐を作らない。
- `packages/xaa-contracts/src/audience.ts` に `audienceIncludes(aud: string | string[], self: string): boolean` を置き、文字列は完全一致、配列は要素の完全一致で判定する。`startsWith` と `includes` を使わない。失敗は 401 `invalid_audience`。
- `scope` はスペース区切り文字列を分割し、`requiredScope` を要素として含むかで判定する。失敗は 403 `insufficient_scope`。Authorization Platform の decisions ルートは `workdef:submit` を要求する。
- 検証済みの値は `c.set('accessToken', { sub, aud, scope, cnf, jti })` で後続へ渡す。生のトークン文字列を context へ入れない（RULE-38）。
- JWKS はプロセス内キャッシュに 300 秒保持し、未知の `kid` を見たときだけ再取得する。再取得は同時に1回に制限する。

**完了条件**
- [ ] `packages/control-plane-auth/test/access-token.spec.ts` に `rejects tampered signature (401)` / `rejects typ=JWT id token (401 invalid_token)` / `rejects aud=authorization-platform on agent-provisioner (401 invalid_audience)` / `rejects missing scope (403 insufficient_scope)` の4テストがあり green。
- [ ] `aud` が `["authorization-platform-staging"]` のトークンで `audience=authorization-platform` の検証が 401 になるテスト（接頭辞一致で通らないこと）が green。
- [ ] `grep -rn "startsWith\|includes(" packages/xaa-contracts/src/audience.ts` の結果が0件。
- [ ] 検証成功時に `c.get('accessToken')` が生トークン文字列を含まないことを assert するテストが green。

---

### T-AUTHZ-06 DPoP Proof 検証ミドルウェアを実装する

**概要**
docs 05 §2.1 の手順4から7に当たる DPoP 検証を `packages/control-plane-auth` へ実装する。
Proof が添付されているかの確認で終わらせず、Access Token の `cnf.jkt` と Proof ヘッダ `jwk` の Thumbprint の一致を必ず取る（RULE-44）。
検証本体は `packages/xaa-crypto` の `verifyDpopProof` を呼び、この領域では呼び出しと `jti` ストアの注入を作る。

**対象要件** REQ-05-020, REQ-05-021
**前提タスク** T-AUTHZ-05、`packages/xaa-crypto` の DPoP 実装（Identity 領域）
**成果物** `packages/control-plane-auth/src/dpop.ts`, `packages/control-plane-auth/src/jti-store.ts`, `packages/control-plane-auth/test/dpop.spec.ts`

**実装方針**
- `dpopMiddleware(options: { iatSkewSeconds, jtiStore, expectedHtu })` を export する。`htu` はクエリとフラグメントを除去した絶対 URI とし、Cloud Run のプロキシ経由でも一致するよう `X-Forwarded-Proto` と `Host` から組み立てる。
- 呼び出し順序を次に固定する。(1) `DPoP` ヘッダの存在（無ければ 401 `invalid_dpop_proof`）、(2) `verifyDpopProof(proof, { htm, htu, ath, iatSkewSeconds, jtiStore })`、(3) `jkt = thumbprint(proof.header.jwk)` と Access Token の `cnf.jkt` のバイト一致。
- `verifyDpopProof` の内部順序は DEC-ID-12 で 署名 → `typ` → `htm` → `htu` → `iat` 窓 → `jti` 重複 → `ath` に固定されている。したがって docs の手順5（`cnf.jkt` 照合）は手順6と7の後に実行される。観測されるステータスとエラーコードは docs と同じであり、複数条件が同時に失敗した場合は `verifyDpopProof` の順序で最初に失敗したものを返し、`cnf.jkt` 不一致は最後に返す。この差は実装ノートとして `packages/control-plane-auth/README.md` に1段落で残す。
- `ath` は Access Token の SHA-256 を base64url した値と一致することを必須にする（DEC-ID-12）。`ath` を持たない Proof は 401 `invalid_dpop_proof`。
- エラーコードの割り当てを固定する。署名と `typ` と `htm` と `htu` と `iat` の失敗は 401 `invalid_dpop_proof`、`jti` 重複は 401 `replayed_dpop_proof`、`cnf.jkt` 不一致は 401 `dpop_key_binding_mismatch`。
- `jti-store.ts` に `MemoryJtiStore` と `FirestoreJtiStore` を置き、`STORE_MODE` で選ぶ。Firestore 側はコレクション `dpop_jti/{jti}` に `expires_at` を持たせ、TTL ポリシーの対象にする。TTL は `DPOP_JTI_TTL_SECONDS`（既定120）とし、`iat` 許容幅（既定±60秒）の2倍にそろえる。
- `jti` の登録は「未登録なら登録して true、既登録なら false」を1回の `create` で判定する。読み出してから書き込む2段構成にしない。

**完了条件**
- [ ] `packages/control-plane-auth/test/dpop.spec.ts` に `rejects stolen token with attacker key proof (401 dpop_key_binding_mismatch)` があり、Proof 署名は正しく Thumbprint だけ不一致のケースを明示的に含んで green。
- [ ] 同一 Proof を2回送ると2回目が 401 `replayed_dpop_proof` になるテストが green。
- [ ] `htm=GET` の Proof で POST した場合、`iat` が5分前の Proof の場合、`ath` が無い Proof の場合の3ケースがすべて 401 `invalid_dpop_proof` になるテストが green。
- [ ] `htu` にクエリ文字列を含む Proof が、クエリ付き URL への要求で通ることを確認するテスト（除去後に一致する）が green。

---

### T-AUTHZ-07 human_subject 照合ミドルウェアを実装する

**概要**
リクエストボディの `human_subject` を Access Token の `sub` と厳密一致で照合し、不一致を 403 で拒否する処理を Control Plane 3アプリ共通で実装する。
ボディに `human_subject` が無い場合は `sub` を注入し、ボディの値を優先する経路をコード上に作らない（RULE-43）。
不一致は Protocol Validation イベント `human_subject_mismatch` として記録する。

**対象要件** REQ-02-010, REQ-05-014, REQ-09-027
**前提タスク** T-AUTHZ-05
**成果物** `packages/control-plane-auth/src/human-subject.ts`, `packages/control-plane-auth/src/protocol-validation.ts`, `packages/control-plane-auth/test/human-subject.spec.ts`, `e2e/test/authorization/human-subject-mismatch.spec.ts`

**実装方針**
- `humanSubjectMiddleware()` を export する。JSON ボディを読み、`human_subject` が存在すれば `=== sub` を大文字小文字を区別する文字列比較で判定する。不一致は 403 `human_subject_mismatch`。
- 存在しない場合は `sub` の値を書き込んだうえで後続へ渡す。以降のハンドラは `c.get('humanSubject')` だけを読み、`await c.req.json()` の `human_subject` を直接読まない。
- 型で誤用を防ぐため、後続ハンドラへ渡すボディ型から `human_subject` を `Omit` し、`humanSubject` を別引数で受け取る形にする。
- `protocol-validation.ts` に `emitProtocolValidation(c, { validation, outcome, error })` を置く。`validation` の許可値は `invalid_signature` / `expired_token` / `audience_mismatch` / `invalid_scope` / `invalid_dpop_proof` / `replayed_dpop_proof` / `dpop_key_binding_mismatch` / `human_subject_mismatch` の8件に限る。出力は構造化ログ1行（DEC-SEC-02）で、`human_subject` と `trace_id` と `timestamp` を含み、トークン本体を含めない。
- Agent Provisioner と Lifecycle Manager はこのミドルウェアを import して使う。同等の処理を各アプリで再実装しない。

**完了条件**
- [ ] `packages/control-plane-auth/test/human-subject.spec.ts` が、`sub=user-123` のトークンで `human_subject: user-456` を送ると 403 `human_subject_mismatch` を返し、`emitProtocolValidation` が1回呼ばれることを assert して green。
- [ ] `human_subject` を省略したリクエストで `c.get('humanSubject') === 'user-123'` となり、処理が成功することを assert するテストが green。
- [ ] `e2e/test/authorization/human-subject-mismatch.spec.ts` が Authorization Platform と Agent Provisioner と Lifecycle Manager の3アプリへ不一致リクエストを送り、3件とも 403 かつ Protocol Validation イベントが3件記録されることを assert して green。
- [ ] `grep -rn "body.human_subject\|body\[.human_subject.\]" apps/authorization/src/routes` の結果が0件。

---

### T-AUTHZ-08 8ステップ検証を1本のミドルウェアへ結線する

**概要**
T-AUTHZ-05 から T-AUTHZ-07 で作った検証を、docs 05 §2.1 の順序どおり1本のミドルウェアへ結線する。
各ステップの結果を Protocol Validation へ送り、Control Plane 3アプリが同じ入口を使うようにする。
RULE-06 と RULE-43 と RULE-44 をまとめて満たす入口を1か所に固定する。

**対象要件** REQ-02-015
**前提タスク** T-AUTHZ-05, T-AUTHZ-06, T-AUTHZ-07
**成果物** `packages/control-plane-auth/src/index.ts`, `packages/control-plane-auth/README.md`, `packages/control-plane-auth/test/step-order.spec.ts`, `apps/authorization/src/app.ts`（変更）

**実装方針**
- `controlPlaneAuth(options: { issuer, jwksUrl, audience, requiredScope, iatSkewSeconds, jtiStore })` を export し、内部で `accessTokenMiddleware` → `dpopMiddleware` → `humanSubjectMiddleware` の順に合成する。
- ステップ番号と失敗時のステータスの対応表をコード内の定数 `STEP_TABLE` として持ち、README にも同じ表を載せる。1（401）、2（401）、3（403）、4（401）、5（401）、6（401）、7（401）、8（403）。
- 早期終了を守る。あるステップで失敗したら後続のステップを実行しない。テストは spy でステップ関数の呼び出し回数を数えて確認する。
- Authorization Platform は `/v1/authorization/decisions` と `/api/work-requests` にこのミドルウェアを適用し、`/healthz` と `/internal/events/human-permission-changed` には適用しない。`/internal/*` は Cloud Run の run.invoker と Pub/Sub push の OIDC トークンで守る（DEC-IAC-14）。
- 8ステップを個別アプリで組み替えられないよう、`accessTokenMiddleware` と `dpopMiddleware` の単体 export は残すがアプリ側から直接使わない規約にし、CI で `apps/*/src` からの個別 import を検査する。

**完了条件**
- [ ] `packages/control-plane-auth/test/step-order.spec.ts` が8ステップそれぞれの失敗ケースについて期待ステータス（401 または 403）と `error` 値を assert し、8テストすべて green。
- [ ] ステップ2で失敗させたとき、ステップ3以降の spy 呼び出し回数が0であることを assert するテストが green。
- [ ] `grep -rn "accessTokenMiddleware\|dpopMiddleware" apps/*/src` の結果が0件。
- [ ] 8ステップそれぞれの失敗で `emitProtocolValidation` が1回ずつ呼ばれることを assert するテストが green。

---

### T-AUTHZ-09 Business Work Request の受信側スキーマ検証を実装する

**概要**
Automation App から届く Business Work Request を厳格スキーマで検証し、権限に関わるフィールドを一切受け付けない。
未知フィールドは 400 `unexpected_field`、権限指定フィールドは 400 `authorization_field_not_allowed` として区別する。
RULE-07（Automation 側に権限情報を持たせない）を受信側で強制する。

**対象要件** REQ-02-009
**前提タスク** T-AUTHZ-08
**成果物** `packages/xaa-contracts/schemas/business-work-request.schema.json`, `apps/authorization/src/validation/work-request.ts`, `apps/authorization/test/work-request-validation.test.ts`

**実装方針**
- スキーマの許可プロパティを `human_subject` / `purpose` / `description` / `constraints` / `requested_lifetime_hours` の5件に固定し、`additionalProperties: false` とする。`required` は `purpose` と `description` と `requested_lifetime_hours`。
- `requested_lifetime_hours` は整数、最小1、最大は `agent_max_lifetime_seconds / 3600` の切り捨て（DEC-IAC-16）。上限超過は 400 `invalid_request`。
- `constraints` は既知キー `external_message_send`（boolean）のみを許可し、それ以外は `unexpected_field` にする。
- 検証は2段にする。(1) 禁止フィールド検査を先に行い、`capabilities` / `effective_capabilities` / `scopes` / `resources` / `isolation_level` / `tools` のいずれかがボディ最上位に存在すれば 400 `authorization_field_not_allowed`、(2) その後 Ajv で検証し、Ajv の `additionalProperties` 違反は 400 `unexpected_field` へ写像する。禁止フィールド検査を先にする理由は、両方に該当する入力で常に `authorization_field_not_allowed` を返すためである。
- 禁止フィールド名の配列は `packages/xaa-contracts/src/forbidden-fields.ts` に置き、Agent Provisioner の入力検証からも同じ配列を使う。
- TypeScript 型は `json-schema-to-ts` で導出する（DEC-APP-05）。手書きの interface を別に定義しない。

**完了条件**
- [ ] `apps/authorization/test/work-request-validation.test.ts` が `{"purpose":"x","description":"y","requested_lifetime_hours":1,"effective_capabilities":["finance.payment.approve"]}` に対し 400 `authorization_field_not_allowed` を返すことを assert して green。
- [ ] 未知フィールド `foo` を1つ足したリクエストが 400 `unexpected_field` になるテストが green。
- [ ] `effective_capabilities` と `foo` の両方を含むリクエストが `authorization_field_not_allowed` を返すテストが green。
- [ ] `requested_lifetime_hours: 0` と `requested_lifetime_hours: 999` がどちらも 400 `invalid_request` になるテストが green。

---

### T-AUTHZ-10 権限決定 API を実装する

**概要**
`POST /v1/authorization/decisions` を実装し、検証済みの Business Work Request から decision を作って応答する。
`human_subject` は常に Access Token の `sub` を正として扱い、ボディの値を以降の処理へ渡さない。
T-AUTHZ-11 以降のモジュールを差し込む土台となるハンドラをここで確定する。

**対象要件** REQ-03-001
**前提タスク** T-AUTHZ-04, T-AUTHZ-09
**成果物** `apps/authorization/src/routes/decisions.ts`, `apps/authorization/src/pipeline/decide.ts`, `apps/authorization/test/decisions.route.test.ts`

**実装方針**
- ハンドラは `decide(input: DecideInput, deps: DecideDeps): Promise<DecideResult>` を呼ぶだけにする。`DecideInput` は `{ humanSubject, purpose, description, constraints, requestedLifetimeHours }` とし、`human_subject` という名前のフィールドを持たせない。
- `decision_id` は `dec_<uuid v4>` とし、サーバ側で生成する。クライアントから受け取らない。
- 応答は `authorization-decision-response.schema.json` で検証してから返す。検証に失敗したら 500 `internal_error` を返し、応答本文を送らない。
- 成功時のステータスは 200。`status` は通常 `decided`、Proposed が空になった場合は `no_capability_inferred`（T-AUTHZ-14 で分岐を実装する）。
- `decide` の中で `Date.now()` を直接呼ばず、`deps.clock.now()` を使う。テストで時刻を固定するためである。
- この段階では AI と Policy Engine をスタブ実装（固定値を返す）にしておき、T-AUTHZ-11 以降で置き換える。スタブは `deps` 経由の差し替えにし、本番コードに分岐を残さない。

**完了条件**
- [ ] `apps/authorization/test/decisions.route.test.ts` の3ケースが green。(a) `sub` 一致時に 200 と `effective_capabilities` を返す、(b) `sub` 不一致時に 403 `human_subject_mismatch`、(c) ボディの `human_subject` を書き換えても保存された decision の `human_subject` が `sub` の値になる。
- [ ] `POST /api/work-requests` へ同じボディを送ると `POST /v1/authorization/decisions` と同一の応答本文になることを assert するテストが green。
- [ ] 応答スキーマ検証を意図的に失敗させたテストで 500 `internal_error` が返り、`effective_capabilities` を含む本文が返らないことを assert して green。

---

### T-AUTHZ-11 Work Definition 構造化モジュールを実装する

**概要**
Business Work Request から Agent Work Definition を組み立て、`operations` と `target_resources` を導出する。
導出は Vertex AI 1回の呼び出しで行い、`target_resources` は Capability Taxonomy の `resource` 列に存在する値だけを残す。
docs 03 §3 の構造化を Authorization Platform 側に閉じ込め、Automation 側へ Resource 一覧を持たせない。

**対象要件** REQ-03-002
**前提タスク** T-AUTHZ-03, T-AUTHZ-10
**成果物** `apps/authorization/src/work-definition/build.ts`, `apps/authorization/src/work-definition/prompt.ts`, `apps/authorization/test/work-definition.test.ts`

**実装方針**
- `buildWorkDefinition(request, deps): Promise<{ workDefinition, dropped }>` を export する。`deps.vertex.generate` を1回だけ呼ぶ。呼び出し回数はテストで spy して固定する。
- Vertex AI の `responseSchema` で `{ operations: string[], target_resources: string[] }` を受ける。自由文の JSON パースを書かない。
- 許可される `target_resources` は `capabilities` コレクションの `resource` の集合（`calendar` / `mail` / `document` / `finance`）とする。定数として直書きせず、起動時に Firestore から読んだ集合を `deps.allowedResources` として渡す。
- 範囲外の値は捨て、`dropped.dropped_target_resource` へ元の値を積む。捨てた結果 `target_resources` が空になっても処理は継続し、Proposed が空になるかどうかは T-AUTHZ-14 の判定に委ねる。
- `operations` は英小文字とアンダースコアのみに正規化し、空文字と重複を除く。件数の上限を10件とし、超過分は捨てて `dropped.dropped_operation` に積む。
- `work_definitions/{work_definition_id}` へ保存する。`work_definition_id` は `wd_<uuid v4>`。

**完了条件**
- [ ] `apps/authorization/test/work-definition.test.ts` が、description「Google Calendarから当日の予定を取得し、重要な予定を抽出して整理する」に対し `operations` が3件以上、`target_resources` が `["calendar"]` になることを assert して green。
- [ ] LLM スタブが `"salesforce"` を返すケースで `target_resources` から消え、`dropped.dropped_target_resource` が1件になることを assert するテストが green。
- [ ] `deps.vertex.generate` の呼び出し回数が1であることを assert するテストが green。
- [ ] `operations` に重複と空文字を含むスタブ応答で、保存された `operations` が重複なし空文字なしになることを assert するテストが green。

---

### T-AUTHZ-12 Authorization AI Agent を実装する

**概要**
Work Definition から必要な Capability を推論する Vertex AI 呼び出しを実装する。
プロンプトへ渡すのは Capability Taxonomy の `capability_id` と `description` のみとし、API URL や HTTP Method や OAuth scope を渡さない（RULE-09）。
応答は構造化出力で受け、`capabilities` と `characteristics` と `confidence` の3つだけを取り出す。

**対象要件** REQ-03-005
**前提タスク** T-AUTHZ-11
**成果物** `apps/authorization/src/ai/authorization-ai.ts`, `apps/authorization/src/ai/vertex-client.ts`, `apps/authorization/src/ai/prompt.ts`, `packages/xaa-contracts/schemas/authorization-ai-result.schema.json`, `apps/authorization/test/authorization-ai.test.ts`

**実装方針**
- `inferCapabilities(input: { description, operations, taxonomy }, deps): Promise<AuthorizationAiResult>` を export する。`taxonomy` は `{ capability_id, description }[]` に射影したうえで渡す。`resource` や `default_characteristics` を渡さない。
- `vertex-client.ts` は `VERTEX_MODE=fake|live` で切り替える（DEC-APP-09）。`fake` は `apps/authorization/src/ai/fixtures/*.json` を返す。モデル名は `VERTEX_MODEL`（既定 `gemini-2.5-flash`）から読み、コードに直書きしない（DEC-APP-10）。
- `responseSchema` は `{ capabilities: string[], characteristics: { write_operation, external_communication, financial_operation, sensitive_resource }, confidence: number }` とし、`additionalProperties: false`。`confidence` は 0 以上 1 以下。
- プロンプト組み立ては `prompt.ts` の `buildPrompt(input): string`1関数に閉じる。組み立て後の文字列に `https://` と `endpoint` と `base_url` が含まれないことを、関数の戻り値に対する assertion（開発時のみ有効ではなく常時実行）で確認し、含まれたら例外を投げる。
- 応答が `responseSchema` に適合しない場合は Vertex AI をリトライせず、`capabilities` を空として扱い warning ログを出す。無限リトライを実装しない。

**完了条件**
- [ ] `apps/authorization/test/authorization-ai.test.ts` が、スタブ応答が `authorization-ai-result.schema.json` に適合することを assert して green。
- [ ] 送信プロンプト文字列に `https://` と `endpoint` と `base_url` が1つも含まれないことを assert するテストが green。
- [ ] プロンプトへ URL を混入させた入力で例外が投げられ、Vertex AI クライアントの呼び出しが0回になるテストが green。
- [ ] `VERTEX_MODE=fake` で外部通信が発生しないことを、HTTP クライアントの spy 呼び出し0回で assert するテストが green。

---

### T-AUTHZ-13 AI 出力ガード（技術値と決定の破棄）を実装する

**概要**
LLM 応答に混入した技術実装値と最終判定を、下流へ渡す前に破棄する。
API URL や OAuth scope の混入は warning として記録しつつ処理を続け、`isolation_level` と allow/deny の確定値は Policy Engine が参照しない形にする。
RULE-09 と RULE-10 と RULE-12 を出力側で担保する。

**対象要件** REQ-03-007, REQ-03-008
**前提タスク** T-AUTHZ-12
**成果物** `apps/authorization/src/ai/output-guard.ts`, `apps/authorization/test/ai-output-guard.test.ts`, `apps/authorization/test/policy-engine-ai-input.test.ts`

**実装方針**
- `sanitizeAiOutput(raw: unknown): { result: AuthorizationAiResult, warnings: string[] }` を export する。戻り値の `result` は `capabilities` と `characteristics` と `confidence` の3キーのみを持つ新しいオブジェクトとして組み立てる。`raw` をスプレッドして再利用しない。
- 破棄対象キーを2群に分ける。技術値群は `api_url` / `http_method` / `token_endpoint` / `oauth_scope` / `bridge_url` / `base_url` / `endpoint`、決定値群は `decision` / `allow` / `deny` / `isolation_level` / `security_profile` / `risk_score`。
- 技術値群の混入は1キーにつき warning を1件出す。warning のコードは `ai_output_contains_technical_field` に固定し、フィールド名を構造化ログのフィールドとして添える。処理は継続する。
- 決定値群の混入も同様に破棄し、warning コード `ai_output_contains_decision_field` を出す。Policy Engine の入力型 `PolicyEngineInput` にこれらのキーを持たせないことで、型レベルでも参照できないようにする。
- `characteristics` は既知4キー（`write_operation` / `external_communication` / `financial_operation` / `sensitive_resource`）だけを取り出す。未知キーは破棄する。
- 出力スキーマ（`authorization-ai-result.schema.json`）へ技術値群と決定値群のプロパティ定義を書かない。

**完了条件**
- [ ] `apps/authorization/test/ai-output-guard.test.ts` が、`api_url` と `oauth_scope` を含む LLM 応答に対し下流へ渡る構造体から両方が消え、warning が2件出ることを assert して green。
- [ ] `isolation_level: "standard"` を含む AI 出力に対し、`characteristics.financial_operation=true` のとき最終 `security_profile.isolation_level` が `full_isolation` になることを `apps/authorization/test/policy-engine-ai-input.test.ts` で assert して green。
- [ ] `PolicyEngineInput` 型に `isolation_level` を代入するコードが `tsc` でコンパイルエラーになることを、型テスト（`// @ts-expect-error` を用いたケース）で固定して green。
- [ ] `sanitizeAiOutput` の戻り値のキー数が常に3であることを、混入ありとなしの両ケースで assert して green。

---

### T-AUTHZ-14 Proposed Capability を Taxonomy 内へ制限する

**概要**
AI が提案した Capability から、Capability Taxonomy に存在しない値を Policy Engine へ渡す前に除去する。
除去後に空になった場合は Policy Engine を呼ばず、`no_capability_inferred` を返す。
RULE-09 の「出力を Taxonomy 内に制限する」を実行経路として固定する。

**対象要件** REQ-03-006
**前提タスク** T-AUTHZ-13
**成果物** `apps/authorization/src/ai/taxonomy-filter.ts`, `apps/authorization/src/pipeline/decide.ts`（変更）, `apps/authorization/test/taxonomy-filter.test.ts`

**実装方針**
- `filterToTaxonomy(capabilities: string[], taxonomy: Set<string>): { kept: string[], dropped: string[] }` を export する。純粋関数にし、Firestore を参照しない。
- `taxonomy` は `decide` の冒頭で1回読み、`Set<string>` にして渡す。フィルタ関数の中で読み直さない。
- 除去した値は decision log の `dropped_out_of_taxonomy` へ配列として残し、`ai_proposals` にも `dropped_out_of_taxonomy` として保存する。
- `kept.length === 0` のとき Policy Engine を呼ばない。`status = 'no_capability_inferred'`、`effective_capabilities = []`、`denied = []`、`security_profile = { risk_score: 0, isolation_level: 'standard', reasons: [] }` を返す。この場合も decision レコードは保存する。
- 大文字小文字の正規化やあいまい一致を行わない。完全一致で判定する。

**完了条件**
- [ ] `apps/authorization/test/taxonomy-filter.test.ts` が、AI が `["calendar.event.read","slack.channel.admin"]` を返したとき Policy Engine への入力が `["calendar.event.read"]` のみ、`dropped_out_of_taxonomy` が `["slack.channel.admin"]` になることを assert して green。
- [ ] AI が範囲外のみを返したケースで Policy Engine 関数の spy 呼び出し回数が0、応答 `status` が `no_capability_inferred` になることを assert するテストが green。
- [ ] `Calendar.Event.Read` のような大文字混じりの値が `dropped` 側へ入ることを assert するテストが green。

---

### T-AUTHZ-15 characteristics 7項目の固定とマージ規則を実装する

**概要**
Risk Policy が参照できる入力を7項目に固定し、Taxonomy 由来と AI 由来の値をマージする。
両者が矛盾する場合は Taxonomy 側を優先し、7項目以外のキーをマージ結果に出さない。
docs 03 §7 が挙げる判定入力を、実装上の1つの型として確定する。

**対象要件** REQ-03-018
**前提タスク** T-AUTHZ-13
**成果物** `packages/xaa-contracts/src/characteristics.ts`, `apps/authorization/src/policy/characteristics.ts`, `apps/authorization/test/characteristics-merge.test.ts`

**実装方針**
- 7項目のキーを次に固定する。`capability_risk`（`low` / `medium` / `high`）、`sensitive_resource`（boolean）、`write_operation`（boolean）、`admin_permission`（boolean）、`external_communication`（boolean）、`financial_operation`（boolean）、`personal_data_access`（boolean）。
- 出所を固定する。Taxonomy の `default_characteristics` からは `capability_risk` / `sensitive_resource` / `admin_permission` / `personal_data_access`、AI の出力からは `write_operation` / `external_communication` / `financial_operation`。
- `mergeCharacteristics(taxonomyDefaults: Characteristics[], aiCharacteristics: Partial<Characteristics>): Characteristics` を export する。純粋関数にする。
- 複数 Capability の集約規則を固定する。boolean は論理和、`capability_risk` は `low < medium < high` の最大値。
- 矛盾時の規則を固定する。Taxonomy 側がそのキーを持つ場合は Taxonomy の値を採用し、AI の値を捨てる。捨てた事実は warning ログ `characteristic_overridden_by_taxonomy` として出す。
- 戻り値は7キーちょうどのオブジェクトとして新規構築する。入力オブジェクトをスプレッドしない。

**完了条件**
- [ ] `apps/authorization/test/characteristics-merge.test.ts` が、Taxonomy の `finance.payment.approve` が `financial_operation: true` を持つとき AI が `false` を返しても最終値が `true` になることを assert して green。
- [ ] マージ結果のキー集合が常に7件ちょうどであることを、余分なキーを含む入力で assert するテストが green。
- [ ] `capability_risk` が `low` と `high` の Capability を同時に含む入力で結果が `high` になることを assert するテストが green。
- [ ] 同一入力を100回マージして全結果が deep equal になることを assert するテストが green。

---

### T-AUTHZ-16 Delegatable Permission の適用を実装する

**概要**
本人には許可されているが Agent へは委譲できない Capability を、Effective から除外する。
`delegatable_permission` に行が無い Capability は既定で委譲不可とし、明示登録を必須にする。
RULE-11 の積集合のうち Delegatable の段を実装する。

**対象要件** REQ-03-011
**前提タスク** T-AUTHZ-03
**成果物** `apps/authorization/policy-data/delegatable-permission.yaml`, `apps/authorization/src/policy/delegatable.ts`, `apps/authorization/policy-data/manifest.yaml`（追記）, `apps/authorization/test/delegatable.test.ts`

**実装方針**
- YAML は `{ capability_id, delegatable, policy_id }` の配列にする。8 Capability のうち `calendar.event.write` を `delegatable: false` とし、他7件を `true` として明示登録する。
- 投入先は `delegatable_permissions/{capability_id}`。
- `applyDelegatable(capabilities: string[], entries: Map<string, DelegatableEntry>): { kept: string[], denied: CapabilityDecision[] }` を export する。純粋関数にする。
- `entries` に存在しない `capability_id` は `delegatable: false` として扱う。既定で許可する分岐を書かない。
- `denied` の要素は `{ capability_id, decision: 'DENY', reason_code: 'not_delegatable', policy_id }` とする。未登録の場合の `policy_id` は `implicit-not-delegatable` に固定する。

**完了条件**
- [ ] `apps/authorization/test/delegatable.test.ts` が、Proposed `[calendar.event.read, calendar.event.write]` かつ Human に両方ありのとき `kept = [calendar.event.read]`、`denied` に `{ capability_id: 'calendar.event.write', reason_code: 'not_delegatable' }` が入ることを assert して green。
- [ ] `delegatable_permissions` に未登録の Capability が `denied` へ入り、`policy_id` が `implicit-not-delegatable` になることを assert するテストが green。
- [ ] seed 後の `delegatable_permissions` の件数が8であることを結線テストで確認できる。

---

### T-AUTHZ-17 Organization Policy の2型を実装する

**概要**
組織全体に適用するポリシーを、Capability を除去する `capability_deny` と、Capability を残して制約を付ける `capability_constraint` の2型として実装する。
社外宛メール送信の禁止は制約として表し、`mail.message.send` を Effective に残したまま宛先ドメインを絞る。
docs 03 §2 の2つの例を、除去と制約に振り分けて実装する。

**対象要件** REQ-03-012
**前提タスク** T-AUTHZ-16
**成果物** `apps/authorization/policy-data/organization-policy.yaml`, `apps/authorization/src/policy/organization.ts`, `apps/authorization/policy-data/manifest.yaml`（追記）, `apps/authorization/test/organization-policy.test.ts`

**実装方針**
- YAML の1行は `{ policy_id, type, match, constraint?, reason_code? }`。`type` は `capability_deny` と `capability_constraint` の2値のみ。
- 初期データを2件置く。`org-001`：`type: capability_constraint`、`match: { capability_id: mail.message.send }`、`constraint: { recipient_domain_allowlist: ["example.com"] }`。`org-002`：`type: capability_deny`、`match: { connector_not_in: ["google-workspace", "internal-api"] }`、`reason_code: org_policy_denied`。
- `applyOrganizationPolicy(capabilities, policies, capabilityConnectors): { kept, constraints, denied }` を純粋関数として export する。`capabilityConnectors` は `Record<capability_id, connector_id[]>` で、Policy Engine を呼ぶ前に Tool Catalog から解決して渡す（REQ-03-021 のため関数内で参照しない）。
- `connector_not_in` の判定は「その Capability に紐づく Connector が1つも許可集合に入っていない場合に除去する」とする。1つでも許可 Connector があれば残す。
- `constraints` は `Record<capability_id, object>` として返し、複数ポリシーが同じ Capability に制約を付ける場合はキー単位のマージ（後勝ちではなく、同一キーが衝突したらエラーを投げる）にする。
- `denied` の `reason_code` は `org_policy_denied` に固定する。自由文を入れない。

**完了条件**
- [ ] `apps/authorization/test/organization-policy.test.ts` が、`mail.message.send` が `kept` に残り、`constraints['mail.message.send'].recipient_domain_allowlist` が `["example.com"]` になることを assert して green。
- [ ] 許可外 Connector にのみ紐づく Capability が `denied`（`reason_code: org_policy_denied`）になることを assert するテストが green。
- [ ] 許可 Connector と許可外 Connector の両方に紐づく Capability が `kept` に残ることを assert するテストが green。
- [ ] 同一 Capability の同一制約キーに異なる値を与える2ポリシーで例外が投げられることを assert するテストが green。

---

### T-AUTHZ-18 Risk Policy の評価と risk_score 算出を実装する

**概要**
characteristics と capability_id の組に対して Risk Policy を評価し、加点と最低 Isolation Level と追加制約と理由コードを得る。
`risk_score` は成立ルールの weight 合計を 0 から 100 にクリップした整数とする。
RULE-12 に従い、Isolation Level の決定権を Policy Engine 側に置く。

**対象要件** REQ-03-013
**前提タスク** T-AUTHZ-15
**成果物** `apps/authorization/policy-data/risk-policy.yaml`, `apps/authorization/src/policy/risk.ts`, `apps/authorization/policy-data/manifest.yaml`（追記）, `apps/authorization/test/risk-policy.test.ts`

**実装方針**
- YAML の1行は `{ policy_id, when, weight, min_isolation_level, reason_code, added_constraint?, deny? }`。`when` は7項目のキーと期待値の連想配列とし、全キー一致で成立とする（論理積のみ。`or` と `not` を実装しない）。
- 初期データを4件置く。`risk-001`：`when: { financial_operation: true }`、`weight: 40`、`min_isolation_level: full_isolation`、`reason_code: financial_operation`、`added_constraint: { max_amount: 100000 }`。`risk-002`：`sensitive_resource: true`、`weight: 25`、`standard`、`sensitive_resource`。`risk-003`：`write_operation: true`、`weight: 15`、`standard`、`write_permission`。`risk-004`：`external_communication: true`、`weight: 10`、`standard`、`external_communication`。
- `evaluateRiskPolicy(characteristics, capabilities, policies): { riskScore, minIsolationLevel, addedConstraints, reasons, denied }` を純粋関数として export する。
- `riskScore = Math.min(100, Math.max(0, Math.round(sum(weight))))` とする。浮動小数を残さない。
- `reasons` は成立ルールの `reason_code` を YAML の記載順で並べ、重複を除く。自由文を入れない。
- `deny: true` を持つルールが成立した Capability は `denied`（`reason_code: risk_policy_denied`）へ入れる。初期データには `deny` を持つルールを置かない。
- `financial_operation` のルールは `risk_score` に関わらず `full_isolation` を返す。スコアによる自動降格の分岐を書かない（specs 5.2 の Risk Policy）。

**完了条件**
- [ ] `apps/authorization/test/risk-policy.test.ts` が、`{ sensitive_resource: true, write_operation: true, financial_operation: true }` に対し `riskScore = 80`、`minIsolationLevel = 'full_isolation'`、`reasons = ['financial_operation','sensitive_resource','write_permission']` が返ることを assert して green。
- [ ] 同じ入力を100回評価して全結果が deep equal になることを assert するテストが green。
- [ ] weight 合計が 100 を超える入力で `riskScore` が 100 に丸められることを assert するテストが green。
- [ ] `evaluateRiskPolicy` 実行中に Firestore クライアントと Vertex AI クライアントの spy 呼び出しが0回であることを assert するテストが green。

---

### T-AUTHZ-19 Effective Capability の集合演算を純粋関数として実装する

**概要**
Effective = Proposed ∩ Human ∩ Delegatable ∩（Organization Policy 適用後）∩（Risk Policy 適用後）を、この順で計算する純粋関数を実装する。
関数内から DB と LLM と時刻と乱数を参照せず、必要な入力はすべて引数で受け取る。
RULE-11 の定義を1つの関数として固定する。

**対象要件** REQ-03-014
**前提タスク** T-AUTHZ-16, T-AUTHZ-17, T-AUTHZ-18
**成果物** `apps/authorization/src/policy/effective.ts`, `packages/xaa-contracts/src/policy-types.ts`, `apps/authorization/test/policy-engine.pure.test.ts`

**実装方針**
- `computeEffectiveCapabilities(input: PolicyEngineInput): PolicyEngineOutput` を export する。`PolicyEngineInput` は `{ proposed, characteristics, humanPermissions, delegatableEntries, organizationPolicies, capabilityConnectors, riskPolicies }` の7フィールド。
- 適用順序を関数内で固定する。(1) Proposed から開始、(2) Human Permission との積、(3) Delegatable 適用、(4) Organization Policy の `capability_deny` 適用、(5) Risk Policy の `capability_deny` 適用。制約の付与（Organization Policy の `capability_constraint` と Risk Policy の `added_constraint`）は除去がすべて終わった後に行う。
- 各段で落ちた Capability を `decisions: CapabilityDecision[]` に積む。`reason_code` は `not_in_human_permission` / `not_delegatable` / `org_policy_denied` / `risk_policy_denied` / `allowed` の5値のみ。
- 出力順序を決定論にする。`effective` と `denied` は `capability_id` の辞書順に並べる。`Set` のイテレーション順に依存しない。
- 関数の引数に clock と乱数生成器を渡さない。`decision_id` の採番はこの関数の外で行う。
- `import` するのは型と `packages/xaa-contracts` の定数のみとする。Firestore クライアントと Vertex クライアントを import しない。

**完了条件**
- [ ] `apps/authorization/test/policy-engine.pure.test.ts` が同一入力100回の出力を deep equal で比較して全一致することを assert して green。
- [ ] docs 03 §2 の例（Proposed `[calendar.event.read, mail.message.send]`、Human 4件、Delegatable で `calendar.event.write` を除外）で `effective = ['calendar.event.read','mail.message.send']` になることを assert するテストが green。
- [ ] 関数実行中の Firestore クライアントと Vertex AI クライアントの spy 呼び出しが0回であることを assert するテストが green。
- [ ] `grep -n "@google-cloud" apps/authorization/src/policy/effective.ts` の結果が0件。

---

### T-AUTHZ-20 Effective ⊆ Human の不変条件を強制する

**概要**
Policy Engine の出力が Human Permission の部分集合であることを、実装内の assertion と property テストの両方で保証する。
違反したら例外を投げ、500 を返し、decision を保存しない。
RULE-11 の不変条件を実行時にも破れないようにする。

**対象要件** REQ-03-015
**前提タスク** T-AUTHZ-19
**成果物** `apps/authorization/src/policy/invariant.ts`, `apps/authorization/src/policy/effective.ts`（変更）, `apps/authorization/test/invariant.property.test.ts`

**実装方針**
- `assertEffectiveSubsetOfHuman(effective: string[], human: string[]): void` を export し、違反時に `EffectiveExceedsHumanPermissionError` を投げる。エラーには超過した `capability_id` の配列を持たせ、生の Human Permission 全体を持たせない。
- 呼び出し位置は `computeEffectiveCapabilities` の `return` 直前1か所に固定する。ルート側での再チェックを追加しない。
- 例外は `src/routes/decisions.ts` で捕捉し、500 `internal_error` を返す。捕捉した時点で decision の保存関数を呼ばない。保存が先行しない順序（Policy Engine の完了後に保存）を守る。
- property テストは乱数生成器を種固定（seed = 20260830）で1000ケース回す。生成する入力は Proposed と Human と Delegatable と Policy の組み合わせとする。
- Human Permission が空の入力で Effective が空になることを個別ケースとして固定する。
- assertion を意図的に無効化した変異版を作るテスト（`vi.spyOn` で assertion を no-op に差し替え、意図的に矛盾する入力を与える）で、`policy_decisions` の行数が増えないことを確認する。

**完了条件**
- [ ] `apps/authorization/test/invariant.property.test.ts` の property テストが1000ケースで違反0件、green。
- [ ] Human Permission を空にした入力で `effective` が空配列になることを assert するテストが green。
- [ ] assertion を no-op へ差し替えた変異テストで例外が発生し、`policy_decisions` への書き込み回数が0であることを assert して green。
- [ ] `grep -rn "assertEffectiveSubsetOfHuman" apps/authorization/src | wc -l` が2（定義1、呼び出し1）。

---

### T-AUTHZ-21 Security Profile の出力形式と決定規則を実装する

**概要**
Security Profile を `{ risk_score, isolation_level, reasons }` の3フィールドで返し、`isolation_level` は成立した全ルールの `min_isolation_level` の最大値とする。
第3の Isolation Level を返す経路を型として存在させない。
RULE-12 と RULE-30 を出力形式として固定する。

**対象要件** REQ-03-017
**前提タスク** T-AUTHZ-18, T-AUTHZ-19
**成果物** `packages/xaa-contracts/schemas/security-profile.schema.json`, `apps/authorization/src/policy/security-profile.ts`, `apps/authorization/test/security-profile.test.ts`

**実装方針**
- `buildSecurityProfile(riskResult): SecurityProfile` を export する。戻り値の型は `{ risk_score: number, isolation_level: IsolationLevel, reasons: string[] }` とし、`isolation_level` の型は T-AUTHZ-02 の `IsolationLevel` をそのまま使う。
- `isolation_level` の集約は `maxIsolationLevel` の畳み込みで行う。成立ルールが0件のときは `standard`。
- `reasons` には成立ルールの `reason_code` のみを入れる。`risk_score` の説明文や Capability 名を入れない。
- JSON Schema の `isolation_level` は `enum: ["standard", "full_isolation"]`、`risk_score` は `type: integer` かつ `minimum: 0` `maximum: 100`、`reasons` は `type: array` の `string`。`additionalProperties: false`。
- 応答へ入れる前に Ajv でこのスキーマを通す。通らなければ 500 `internal_error`。

**完了条件**
- [ ] `apps/authorization/test/security-profile.test.ts` が、`standard` を返すルールと `full_isolation` を返すルールが同時成立したとき `full_isolation` になることを assert して green。
- [ ] 成立ルール0件のとき `{ risk_score: 0, isolation_level: 'standard', reasons: [] }` になることを assert するテストが green。
- [ ] `isolation_level` に `'partial'` を代入するコードが `tsc` でコンパイルエラーになることを型テストで固定して green。
- [ ] `risk_score: 101` の Security Profile が Ajv で reject されることを assert するテストが green。

---

### T-AUTHZ-22 Capability 単位の ALLOW / DENY と理由を永続化する

**概要**
評価した全 Capability について ALLOW と DENY と理由コードと Policy ID を保存する。
理由コードは列挙値に限り、自由文を入れない。
docs 03 §6 の「Policy ID と Decision Reason を監査用に残す」を実装する。

**対象要件** REQ-03-016
**前提タスク** T-AUTHZ-19
**成果物** `apps/authorization/src/store/policy-decision-store.ts`, `packages/xaa-contracts/src/reason-codes.ts`, `apps/authorization/test/policy-decision-store.test.ts`

**実装方針**
- コレクション `policy_decisions/{decision_id}__{capability_id}` に `{ decision_id, capability_id, decision, reason_code, policy_id, created_at }` を保存する。
- `reason-codes.ts` に2つの列挙を置く。永続化用の `REASON_CODES = ['not_in_human_permission','not_delegatable','org_policy_denied','risk_policy_denied','allowed']` と、ログおよび Activity Event 用の `VIOLATION_CODES = ['human_permission_exceeded','delegatable_permission_violation','organization_policy_violation','risk_policy_violation']`。
- 両者の対応表 `REASON_TO_VIOLATION` を同じファイルに置く。`not_in_human_permission → human_permission_exceeded`、`not_delegatable → delegatable_permission_violation`、`org_policy_denied → organization_policy_violation`、`risk_policy_denied → risk_policy_violation`、`allowed → null`。REQ-09-006 と REQ-11-031 が使う語彙はこの表を経由して導出し、別名を新たに作らない。
- 書き込み前に `reason_code` が `REASON_CODES` に含まれることを検証し、含まれなければ例外を投げる。CHECK 制約の代替はこの検証である（DEV-05）。
- 保存件数は Proposed（Taxonomy フィルタ後）の件数と一致させる。ALLOW も DENY も同じコレクションへ書く。
- 書き込みは Firestore の `batch` で1回にまとめる。Capability ごとに個別コミットしない。

**完了条件**
- [ ] `apps/authorization/test/policy-decision-store.test.ts` が、decisions API を1回呼んだ後に `policy_decisions` の行数が Proposed 件数と一致することを assert して green。
- [ ] `reason_code` に `'because it looked risky'` を渡すと例外が投げられ、`policy_decisions` への書き込みが0件になることを assert するテストが green。
- [ ] `REASON_TO_VIOLATION` の全キーが `REASON_CODES` を網羅し、値が `VIOLATION_CODES` か `null` であることを assert するテストが green。

---

### T-AUTHZ-23 権限決定フローを結線し Policy Engine へ4入力を同時に渡す

**概要**
Work Definition から Authorization AI Agent、Proposed Capability、Policy Engine、Effective Capability と Security Profile までを1リクエスト内で処理する。
Policy Engine を呼ぶ前に Human と Delegatable と Organization と Risk の4入力をすべて取得し、Policy Engine 内から追加の外部呼び出しを行わせない。
docs 03 §8 のフロー図を実行経路として固定する。

**対象要件** REQ-03-021
**前提タスク** T-AUTHZ-14, T-AUTHZ-15, T-AUTHZ-19, T-AUTHZ-21, T-AUTHZ-22
**成果物** `apps/authorization/src/pipeline/decide.ts`（変更）, `apps/authorization/src/pipeline/load-policy-inputs.ts`, `apps/authorization/test/decide-pipeline.test.ts`

**実装方針**
- `loadPolicyInputs(humanSubject, capabilities, deps): Promise<PolicyEngineInput>` を実装し、Human Permission、Delegatable Permission、Organization Policy、Risk Policy、Capability と Connector の対応（Tool Catalog 由来）を並行取得する。取得は `Promise.all` の1か所にまとめる。
- `decide` の処理順を固定する。(1) work request 検証、(2) `buildWorkDefinition`、(3) `inferCapabilities`、(4) `sanitizeAiOutput`、(5) `filterToTaxonomy`、(6) `mergeCharacteristics`、(7) `loadPolicyInputs`、(8) `computeEffectiveCapabilities`、(9) `buildSecurityProfile`、(10) proposal 保存、(11) decision と policy_decisions 保存、(12) Activity Event 発行、(13) 応答。
- (8) の呼び出し以降で Firestore への読み取りを行わない。読み取りは (7) までに終える。
- `PolicyEngineInput` の組み立ては `loadPolicyInputs` の中だけで行い、`decide` から個別の store 関数を直接呼ばない。
- (5) の結果が空なら (6) 以降を飛ばして `no_capability_inferred` を返す（T-AUTHZ-14 の分岐をここで結線する）。

**完了条件**
- [ ] `apps/authorization/test/decide-pipeline.test.ts` が、`computeEffectiveCapabilities` の引数に7フィールドすべてが非 undefined で含まれることを assert して green。
- [ ] Policy Engine 実行中の Firestore クライアントと Vertex AI クライアントの spy 呼び出しが0回であることを assert するテストが green。
- [ ] 各ステップの spy を記録し、実行順が上記(1)から(13)の並びと一致することを assert するテストが green。
- [ ] Taxonomy フィルタ後が空のケースで (6) から (9) の spy 呼び出しが0回になることを assert するテストが green。

---

### T-AUTHZ-24 Authorization AI Agent のログを出力する

**概要**
AI 推論のたびに7項目を構造化ログへ出す。
Work Definition の本文は出さず、SHA-256 のハッシュで代替する。
RULE-38 と docs 09 §2 の収集項目に対応する。

**対象要件** REQ-09-005
**前提タスク** T-AUTHZ-12
**成果物** `apps/authorization/src/log/logger.ts`, `apps/authorization/src/log/ai-log.ts`, `apps/authorization/test/ai-log.test.ts`

**実装方針**
- `logger.ts` は Cloud Logging が構造化ログとして解釈できる JSON 1行を stdout へ書く。フィールドは `severity` と `message` と `event` と任意の追加フィールド。ライブラリを追加せず `console.log(JSON.stringify(...))` で実装する（DEC-APP-08）。
- 全ログ共通で `human_subject` と `agent_id` と `trace_id` と `timestamp` を含める。`agent_id` は決定時点で未確定のため `null` を明示的に入れる。
- `logAiInference(fields)` が出す項目を7件に固定する。`agent_draft_id`、`work_definition_id`、`work_definition_hash`、`inferred_capabilities`、`confidence`、`taxonomy_version`、`model_version`。`event` は `authorization.ai_inference`。
- `work_definition_hash` は `description` と `operations` を JSON 正規化した文字列の SHA-256 を hex で出す。本文と `purpose` の自由文を出さない。
- `taxonomy_version` は `TAXONOMY_VERSION` 環境変数ではなく `capability_taxonomy` から読んだ実データの `version` を使う。
- ログ出力は推論1回につき1行にする。プロンプト全文とレスポンス全文を出さない。

**完了条件**
- [ ] `apps/authorization/test/ai-log.test.ts` が推論1回に対し7項目すべてが出力されることを assert して green。
- [ ] ログ全体の文字列に Work Definition の `description` 本文が含まれないことを assert するテストが green。
- [ ] 推論1回に対し `event === 'authorization.ai_inference'` の行がちょうど1件であることを assert するテストが green。

---

### T-AUTHZ-25 Policy Engine のログを出力する

**概要**
判定のたびに Proposed と Effective と Security Profile と Isolation Level と ALLOW / DENY と Policy ID と Decision Reason を出す。
DENY になった Capability は理由コードとともに1件ずつ個別の行として出す。
docs 09 §2 の Policy Engine 行に対応する。

**対象要件** REQ-09-006
**前提タスク** T-AUTHZ-22, T-AUTHZ-24
**成果物** `apps/authorization/src/log/policy-log.ts`, `apps/authorization/test/policy-log.test.ts`

**実装方針**
- 判定1回につき要約行を1件出す。`event` は `authorization.policy_decision`、フィールドは `decision_id`、`proposed_capabilities`、`effective_capabilities`、`risk_score`、`reasons`、`isolation_level`。
- 加えて Capability 1件につき1行を出す。`event` は `authorization.capability_decision`、フィールドは `decision_id`、`capability_id`、`decision`（`ALLOW` または `DENY`）、`reason_code`、`violation_code`、`policy_id`。
- `violation_code` は T-AUTHZ-22 の `REASON_TO_VIOLATION` で導出する。ALLOW 行では `null` を明示的に入れる。
- Capability 名以外の自由文を出さない。Work Definition の本文と AI のプロンプトを出さない。
- 検知 SQL（DEC-SEC-01）が使えるよう、フィールド名をこの1か所で固定し、他アプリと重複する名前（`decision_id` など）の意味を変えない。

**完了条件**
- [ ] `apps/authorization/test/policy-log.test.ts` が、1件 ALLOW と1件 DENY を含む判定に対し DENY 側の行に `violation_code` が付くことを assert して green。
- [ ] 判定1回に対し `authorization.policy_decision` が1行、`authorization.capability_decision` が Proposed 件数分出ることを assert するテストが green。
- [ ] ALLOW 行の `violation_code` が `null` であることを assert するテストが green。

---

### T-AUTHZ-26 Authorization Platform の Activity Event を発行する

**概要**
CAPABILITY_DECIDED と ISOLATION_DECIDED を Pub/Sub トピック `agent-activity-stream` へ発行する。
CAPABILITY_DECIDED の `message` には許可と却下の両方と却下理由を含め、`denied` が0件でもイベントを出す。
RULE-55 に従い、Security Detection 向けの詳細ログとは別系統で発行する。

**対象要件** REQ-11-015
**前提タスク** T-AUTHZ-22, T-AUTHZ-23
**成果物** `apps/authorization/src/activity/publish.ts`, `apps/authorization/src/activity/messages.ts`, `apps/authorization/test/activity-events.test.ts`

**実装方針**
- `publishActivityEvent(event, deps)` は `ACTIVITY_TOPIC`（既定 `agent-activity-stream`）へ publish する。Cloud Logging を経由しない。`PUBSUB_MODE=inproc|gcp` で差し替える。
- CAPABILITY_DECIDED は `phase: 'authorization'`、`outcome: 'info'`、`task_id: 'provisioning'`、`agent_id: null`。`detail` は `{ allowed: string[], denied: [{ capability_id, violation_code }], policy_ids: string[] }`。
- `message` の生成規則を `messages.ts` に固定する。許可0件のとき「許可なし」と書き、却下0件のとき却下節を出さない。`denied` が0件でもイベント自体は発行する。
- ISOLATION_DECIDED は `detail` に `{ isolation_level, risk_score, reasons }` を入れ、`message` に `isolation_level` と `risk_score` の両方を文字列として含める。
- 発行順は CAPABILITY_DECIDED、ISOLATION_DECIDED の順に固定する。publish 失敗は API を失敗させず warning ログ `activity_publish_failed` を出して継続する（表示用の系統であり、決定の成否を左右しないため）。
- `is_simulated` は常に `false` を明示的に入れる。台本デモの経路（DEC-DEMO-01）はこのアプリを通らない。

**完了条件**
- [ ] `e2e/test/authorization/events-authorization.spec.ts` が、1件却下を含む判定に対し `message` に却下された Capability 名と理由が現れ、`detail.denied` が1要素であることを assert して green。
- [ ] ISOLATION_DECIDED の `message` に `isolation_level` と `risk_score` の値が含まれることを assert するテストが green。
- [ ] `denied` が0件の判定でも CAPABILITY_DECIDED が1件発行されることを assert するテストが green。
- [ ] publish を失敗させたテストで API が 200 を返し、warning ログが1件出ることを assert して green。

---

### T-AUTHZ-27 Human Permission 変更イベントを受けて Policy Engine のみで再評価する

**概要**
Pub/Sub トピック `human-permission-changed` を購読し、対象ユーザーの ACTIVE と EXPIRING の Agent を列挙して Effective Capability を再計算する。
保存済みの Proposed Capability と characteristics を再利用し、Vertex AI を呼ばない。
at-least-once 配信のため、同一 `changed_at` の重複配信を冪等に処理する。

**対象要件** REQ-07-027, REQ-03-022
**前提タスク** T-AUTHZ-04, T-AUTHZ-23
**成果物** `apps/authorization/src/routes/permission-changed.ts`, `apps/authorization/src/reevaluate/reevaluate.ts`, `apps/authorization/src/reevaluate/idempotency.ts`, `apps/authorization/test/permission-change.test.ts`, `apps/authorization/test/re-evaluate.test.ts`

**実装方針**
- 受け口は `POST /internal/events/human-permission-changed`。Pub/Sub push subscription から呼ばれ、Cloud Run の run.invoker と push 用 SA の OIDC トークンで守る。`controlPlaneAuth` を適用しない。
- ボディは Pub/Sub の push 形式（`message.data` が base64）とし、デコード後に `{ human_subject, changed_at }` を必須、`capability_id` と `action` を任意として検証する。
- 冪等キーは `${human_subject}:${changed_at}` とし、`permission_change_receipts/{key}` へ `create` で登録する。既存なら 204 を返して処理を打ち切る。読み出してから判定する2段構成にしない。
- 対象 Agent の列挙は `agents` コレクションを `human_subject` と `status in ['ACTIVE','EXPIRING']` で引く。他ユーザーの Agent を含めない。
- 各 Agent の `decision_id` から `ai_proposals` の `proposed_capabilities` と `characteristics` を読み、`loadPolicyInputs` で最新の4入力を取り直したうえで `computeEffectiveCapabilities` を実行する。`inferCapabilities` と `buildWorkDefinition` を呼ばない。
- 応答は常に 204。失敗時のみ 500 を返し Pub/Sub に再配信させる。エラー時に部分的な書き込みを残さないよう、Agent 単位で処理を独立させる。

**完了条件**
- [ ] `apps/authorization/test/permission-change.test.ts` が、再評価時に Vertex AI クライアントの spy 呼び出しが0回であることを assert して green。
- [ ] 対象ユーザーの ACTIVE と EXPIRING の Agent だけが列挙され、他ユーザーと `EXPIRED` の Agent が0件であることを assert するテストが green。
- [ ] 同一メッセージを2回配信して2回目が 204 で打ち切られ、Policy Engine の spy 呼び出し回数が1回分に留まることを assert するテストが green。
- [ ] `apps/authorization/test/re-evaluate.test.ts` が、Policy Engine の呼び出し回数が対象 ACTIVE Agent 数と一致することを assert して green。

---

### T-AUTHZ-28 再評価結果ごとの分岐を実装する

**概要**
新旧の Effective Capability の集合関係から、変化なし、縮小、拡大、混在の4通りに分岐する。
縮小と混在のときだけ Lifecycle Manager へ Re-Provisioning を依頼し、拡大は既存 Agent へ反映しない。
RULE-13 と RULE-14 を、既存 Agent の権限を更新する経路を作らないことで担保する。

**対象要件** REQ-07-028
**前提タスク** T-AUTHZ-27
**成果物** `apps/authorization/src/reevaluate/classify.ts`, `apps/authorization/src/reevaluate/reprovision-client.ts`, `apps/authorization/test/reevaluate-branch.test.ts`

**実装方針**
- `classifyChange(oldSet: string[], newSet: string[]): 'unchanged' | 'shrunk' | 'expanded' | 'mixed'` を純粋関数として export する。判定は集合の包含関係のみで行い、順序に依存しない。
- 分岐を固定する。`unchanged` は何もしない。`shrunk` は Re-Provisioning を依頼する。`expanded` は依頼せず Activity Event を1件記録して終了する。`mixed` は縮小があるとみなして依頼し、渡す新 Effective Capability から拡大分を除外する（`newSet ∩ oldSet` を渡す）。
- `reprovision-client.ts` は `POST {LIFECYCLE_BASE_URL}/agents/{agent_id}/reprovision` を呼ぶ。認証は Cloud Run 間呼び出し用の Google 発行 ID Token（audience は Lifecycle Manager の URL）とし、DPoP を付けない（DEC-ID-13 の3経路に含まれないため）。
- 既存 Agent の `effective_capabilities` を更新する関数と API を実装しない。`decision-store.ts` に更新系の関数を追加しない。
- 拡大時の Activity Event は `PERMISSION_CHANGE_IGNORED`（`phase: 'authorization'`、`outcome: 'info'`）とする。docs 11 §3.2 の表は代表例であり、この event_type を追加として `docs/11-activity-timeline.md` の表へ1行足す。
- 再評価の結果は新しい decision レコードとして保存し、旧 decision を書き換えない。

**完了条件**
- [ ] `apps/authorization/test/reevaluate-branch.test.ts` の4ケース（`unchanged` / `shrunk` / `expanded` / `mixed`）が期待どおりに分岐して green。
- [ ] `expanded` のケースで Lifecycle Manager クライアントの spy 呼び出しが0回であることを assert して green。
- [ ] `mixed` のケースで Re-Provisioning へ渡す Effective Capability に拡大分が含まれないことを assert して green。
- [ ] `grep -rn "updateEffectiveCapabilities\|patchAgentCapabilities" apps/authorization/src` の結果が0件。

---

### T-AUTHZ-29 Calendar と Mail のケースを回帰テストとして固定する

**概要**
docs 03 §2 の例（Google Calendar を読んで重要な予定を関係者へメール送信する）を、5段階の中間値を明示的に比較する回帰テストにする。
Proposed から Effective までの各段で何が落ち何が残るかを、テストコード上に固定する。
Organization Policy の制約が Effective に残る形（除去ではない）であることをここで確認する。

**対象要件** REQ-03-023
**前提タスク** T-AUTHZ-23, T-AUTHZ-26
**成果物** `e2e/test/authorization/calendar-mail-case.spec.ts`, `apps/authorization/src/ai/fixtures/calendar-mail.json`

**実装方針**
- `e2e/harness` の同一プロセス結線（DEC-APP-07）で Authorization Platform を起動し、`VERTEX_MODE=fake` で fixture を返す。
- `human_subject` は `user-123`、`sub` も `user-123` とする。Access Token と DPoP Proof はテストヘルパで生成する。
- 5段階の中間値を個別の `expect` として書く。(1) Proposed が `['calendar.event.read','mail.message.send']`、(2) Human が4件、(3) Delegatable 適用後に `calendar.event.write` が `denied`（`not_delegatable`）、(4) Organization Policy 適用後も `mail.message.send` が残り制約が付く、(5) Risk Policy で `standard` 許容。
- 最終 Effective が `['calendar.event.read','mail.message.send']` で、`mail.message.send` の constraint に `recipient_domain_allowlist: ['example.com']` が入ることを assert する。
- 中間値は API 応答からではなく、`policy_decisions` と `ai_proposals` の保存内容から読む。応答だけを見るテストにしない。

**完了条件**
- [ ] `pnpm test:e2e authorization/calendar-mail-case` が green。
- [ ] テストコード内に5段階それぞれの中間値を比較する `expect` が存在することを、`grep -c "expect(" e2e/test/authorization/calendar-mail-case.spec.ts` が5以上であることで確認できる。
- [ ] `security_profile.isolation_level` が `standard` であることを assert して green。
- [ ] Vertex AI クライアントの spy 呼び出しが1回（Work Definition 構造化）と1回（Capability 推論）の計2回であることを assert して green。

---

### T-AUTHZ-30 Finance ケース（FULL_ISOLATION）を回帰テストとして固定する

**概要**
docs 02 §4 の financial_operation の例（承認済み支払情報を確認し支払処理を実行する）を回帰テストにする。
Effective が2件になり、`isolation_level` が `full_isolation`、`reasons` に `financial_operation` が入ることを固定する。
RULE-12 と specs 5.2 の「risk_score に関わらず無条件で full_isolation」をテストで固める。

**対象要件** REQ-03-024
**前提タスク** T-AUTHZ-29
**成果物** `e2e/test/authorization/finance-case.spec.ts`, `apps/authorization/src/ai/fixtures/finance.json`

**実装方針**
- `human_subject` と `sub` を `user-456` とする。Human Permission は seed の4件（`finance.payment.read` / `finance.payment.approve` / `document.read` / `document.write`）。
- fixture の AI 出力は `capabilities: ['finance.payment.read','finance.payment.approve']`、`characteristics.financial_operation: true`。
- Effective が `['finance.payment.approve','finance.payment.read']`（辞書順）になることを assert する。
- `security_profile.isolation_level` が `full_isolation`、`reasons` に `financial_operation` が含まれることを assert する。
- `risk_score` を意図的に下げた Risk Policy（weight を1にした版）でも `isolation_level` が `full_isolation` のままであることを、追加ケースとして assert する。スコアによる降格が無いことを固定するためである。
- `finance.payment.approve` の constraint に Risk Policy 由来の `max_amount` が入ることを assert する（specs 5.2 の二重検証のうち、Authorization 側で付与される側）。

**完了条件**
- [ ] `pnpm test:e2e authorization/finance-case` が green。
- [ ] `security_profile.isolation_level === 'full_isolation'` と `reasons.includes('financial_operation')` を assert して green。
- [ ] weight を1にした Risk Policy でも `isolation_level` が `full_isolation` のままであることを assert するケースが green。
- [ ] `effective_capabilities` のうち `finance.payment.approve` の constraint に `max_amount` が存在することを assert して green。

---

### T-AUTHZ-31 Organization Policy 違反のデモ経路を実操作で通す

**概要**
社外ドメイン宛の送信を含む作業を依頼し、Policy Engine の判定が Activity Event へ現れるところまでを E2E で再現する。
攻撃コードを書かず、通常の API とデータ経路だけを使う（DEC-DEMO-01 の実操作デモ）。
デモ D-2 の観測結果を、テストとして固定する。

**対象要件** REQ-11-031
**前提タスク** T-AUTHZ-26, T-AUTHZ-29
**成果物** `e2e/test/authorization/org-policy-denied.spec.ts`, `apps/authorization/src/ai/fixtures/external-mail.json`, `apps/authorization/policy-data/organization-policy.yaml`（追記）

**実装方針**
- 依頼内容は「社外の取引先へ会議の要約をメール送信する」とし、fixture の AI 出力に `mail.message.send` と `external_communication: true` を含める。
- specs 6.1 の D-2 に合わせ、Effective には `mail.message.send` が `recipient_domain_allowlist: ['example.com']` 付きで残ることを assert する。社外宛が落ちるのは Tool Executor 側の constraint 検証であり、Authorization 側で Capability ごと除去しない。
- あわせて `capability_deny` 側の観測も同じシナリオで取る。許可外 Connector にのみ紐づく Capability（`org-002` の対象）を1件 Proposed に含めた fixture を使い、CAPABILITY_DECIDED の `detail.denied` に `organization_policy_violation` が現れることを assert する。
- 検証は Activity Event の `detail` に対して行う。`policy_decisions` の `reason_code`（`org_policy_denied`）と Activity Event の `violation_code`（`organization_policy_violation`）の両方を突き合わせ、T-AUTHZ-22 の対応表どおりであることを確認する。
- テスト内で Policy Engine を直接呼ばない。API 経由の実操作だけで再現する。

**完了条件**
- [ ] `e2e/test/authorization/org-policy-denied.spec.ts` が、CAPABILITY_DECIDED の `detail.denied` に `organization_policy_violation` を持つ要素が1件あることを assert して green。
- [ ] `effective_capabilities` に `mail.message.send` が残り、その constraint に `recipient_domain_allowlist` が入ることを assert して green。
- [ ] 同じ decision の `policy_decisions` に `reason_code: 'org_policy_denied'` の行が1件あることを assert して green。
- [ ] テストコードに Policy Engine 関数の直接 import が無いことを `grep -c "policy/effective" e2e/test/authorization/org-policy-denied.spec.ts` が0であることで確認できる。

---

### T-AUTHZ-32 権限縮小による作り直しのデモ経路を実操作で通す

**概要**
`pnpm perm:set` で Human Permission を縮小し、再評価から Re-Provisioning 依頼までを E2E で再現する。
拡大では何も起きないことを同じテストで確認し、RULE-13 と RULE-14 の非対称性を固定する。
デモ D-4 の観測結果を、テストとして固定する。

**対象要件** REQ-11-033
**前提タスク** T-AUTHZ-28, T-AUTHZ-30
**成果物** `e2e/test/authorization/permission-shrink.spec.ts`

**実装方針**
- 前段として `user-456` の Finance ケース（T-AUTHZ-30 と同じ入力）で Agent を1件作る。Agent の作成は Provisioner のスタブではなく結線した実アプリを使い、`agents/{agent_id}` の `status` を `ACTIVE` にする。
- `pnpm perm:set user-456 finance.payment.approve revoke` を実行し、inproc Pub/Sub 経由で `POST /internal/events/human-permission-changed` を配送する。
- 縮小側の assert は3点。Vertex AI クライアントの呼び出しが0回、Lifecycle Manager の `reprovision` が1回、新しい decision の `effective_capabilities` が縮小後の Human Permission の部分集合であること。
- `RE_PROVISIONED` の Activity Event は Lifecycle Manager が発行する。このテストでは Lifecycle 側のスタブが受けた依頼の回数と本文を assert し、イベント本文の検証は Lifecycle 領域のテストに委ねる。
- 拡大側は `pnpm perm:set user-456 finance.payment.approve grant` を実行し、`reprovision` の呼び出しが0回、既存 Agent の `effective_capabilities` が変化しないこと、`PERMISSION_CHANGE_IGNORED` が1件出ることを assert する。
- 縮小と拡大を1つの spec ファイル内で順に実行する。順序依存を避けるため、各ケースの前に Firestore エミュレータのデータを初期化する。

**完了条件**
- [ ] `e2e/test/authorization/permission-shrink.spec.ts` の縮小ケースで `reprovision` が1回呼ばれ、新 decision の `effective_capabilities` が縮小後の Human Permission の部分集合であることを assert して green。
- [ ] 拡大ケースで `reprovision` の呼び出しが0回、既存 Agent の `effective_capabilities` が変化しないことを assert して green。
- [ ] 両ケースを通じて Vertex AI クライアントの spy 呼び出しが0回であることを assert して green。
- [ ] 拡大ケースで `PERMISSION_CHANGE_IGNORED` の Activity Event が1件発行されることを assert して green。
