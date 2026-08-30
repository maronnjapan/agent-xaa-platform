# 06. Agent Provisioner と Tool Catalog（T-PROV）

Agent Provisioner は、Automation App から承認済みの Agent Definition を受け取り、動作する Agent を1体作り出す Control Plane アプリである。
Tool / Connector Catalog は、抽象 Capability を「どの API を、どの認証方式で、どの audience と resource と scope で呼ぶか」へ翻訳する定義データである。
この領域では、Catalog の定義とその解決、Provisioning Transaction と Consent の中断と再開、Agent Registration と Agent Client Credential の生成、Agent OP へ注入する XAA 静的設定と Agent Runtime へ渡す Tool Manifest の生成、FULL_ISOLATION の Dedicated OP 一式の実行時作成、Cloud Run Job Execution の起動までを作る。
Provisioner は GCP リソースを1つも作らない。
作るのは Firestore 上のレコードと、Cloud Run Job Execution の起動要求だけである（DEC-IAC-07、DEC-IAC-08）。

| 前提 | 内容 |
|---|---|
| 依存する領域 | Infra（KMS Key Ring、作成権限、Job 定義、Firestore、Pub/Sub、platform_endpoints）、Authorization（`authorization_decisions` と `human_permissions`）、Agent OP（Registration の読み出しと IdP Connection の作成）、Runtime（Tool Manifest の消費）、Bridge（Agent Binding、既定では無効） |
| このファイルのタスク数 | 32件 |
| 主に満たす設計ルール | RULE-03, RULE-04, RULE-11, RULE-16, RULE-19, RULE-20, RULE-22, RULE-25, RULE-26, RULE-29, RULE-31, RULE-32, RULE-43, RULE-44, RULE-50, RULE-51, RULE-55, RULE-59 |

---

### T-PROV-01 Tool / Connector Catalog のスキーマと型を定義する

**概要**
Catalog は Cloud SQL のテーブルではなく Firestore のコレクションとして持つ（DEC-IAC-09）。
Connector と Tool の2種類のドキュメント形状を JSON Schema で確定し、TypeScript 型を導出する。
Capability 名と scope 名と Tool ID は DEC-SCOPE-03 で確定した1組のみを許し、別名を作らない。

**対象要件** REQ-01-013
**前提タスク** なし
**成果物**
- `packages/xaa-contracts/src/names.ts`
- `packages/xaa-contracts/src/schemas/catalog-connector.schema.json`
- `packages/xaa-contracts/src/schemas/catalog-tool.schema.json`
- `packages/xaa-contracts/src/catalog-types.ts`
- `packages/xaa-contracts/test/names.spec.ts`

**実装方針**
- `names.ts` に `CAPABILITY_IDS`（8件）、`RESOURCE_SCOPES`（7件）、`TOOL_IDS`（8件）、`CONNECTOR_IDS`（3件）を `as const` の配列で置き、そこから union 型を導出する。値は specs 5.0 の確定表と完全に一致させる。
- Capability は `calendar.event.read` / `calendar.event.write` / `mail.message.read` / `mail.message.send` / `document.read` / `document.write` / `finance.payment.read` / `finance.payment.approve` の8件。
- scope は `docs.read` / `docs.write` / `finance.tx.read` / `finance.tx.write` / `calendar.read` / `gmail.read` / `gmail.send` の7件。
- Tool ID は `internal.document.list` / `internal.document.get` / `internal.document.create` / `internal.document.update` / `internal.finance.payment.list` / `internal.finance.payment.get` / `internal.finance.payment.approve` / `stub.calendar.events.list` の8件。
- Connector ID は `internal-docs-api` / `internal-finance-api` / `stub-saas-calendar` の3件。
- Connector ドキュメント（`catalog_connectors/{connector_id}`）のフィールドは `connector_id` / `resource_type`（`native_xaa` または `oauth_bridge`）/ `audience` / `resource` / `risk_level`（`low` / `medium` / `high`）/ `enabled`（boolean）の6件に固定する。
- Tool ドキュメント（`catalog_tools/{tool_id}`）のフィールドは `tool_id` / `description` / `required_capability` / `connector_id` / `auth_type` / `xaa_audience` / `xaa_resource` / `xaa_scope` / `api_base_url` / `http_method` / `path_template` / `parameters` / `constraints` / `response_schema` / `risk_level` に固定する。
- 検証は Ajv の strict モード、`additionalProperties: false` とし、TypeScript 型は json-schema-to-ts で導出する（DEC-APP-05）。
- Capability ID の形式検査を `assertCapabilityIdShape(id)` として置き、`<resource>.<object>.<action>` または `<resource>.<action>` に一致しない値、ベンダー名（google / microsoft / github / slack）、HTTP メソッド名（get / post / put / patch / delete）を含む値を例外にする。
- 破棄した別名（`document.content.read`、`documents.read`、`transactions.read`、`transfers.write`、`docs.document.get`、`internal.customer.*`）を定数として定義しない。

**完了条件**
- [ ] `pnpm vitest run packages/xaa-contracts/test/names.spec.ts` が緑になり、`CAPABILITY_IDS.length === 8` / `RESOURCE_SCOPES.length === 7` / `TOOL_IDS.length === 8` を assert している
- [ ] `assertCapabilityIdShape("google.calendar.get")` が例外を投げるテストが通る
- [ ] `catalog-tool.schema.json` に未知フィールドを含むドキュメントを Ajv へ渡すと検証に失敗するテストが通る
- [ ] `grep -rn "document.content.read\|transactions.read\|docs.document.get" packages/ apps/` の結果が0件である

---

### T-PROV-02 Catalog のシードデータと投入ジョブを作成する

**概要**
Catalog は管理者が管理する定義データであり、AI もアプリも編集しない（docs 04 §1）。
リポジトリ内の YAML を正とし、投入ジョブが Firestore へ upsert する。
Resource の URL は Terraform が書き出した `platform_endpoints` から解決し、YAML にもコードにも直書きしない（DEC-IAC-06）。

**対象要件** REQ-01-013
**前提タスク** T-PROV-01
**成果物**
- `apps/provisioner/seed/connectors.yaml`
- `apps/provisioner/seed/tools.yaml`
- `apps/provisioner/src/seed/main.ts`
- `apps/provisioner/test/seed.spec.ts`

**実装方針**
- `connectors.yaml` に3件を書く。`internal-docs-api`（`native_xaa`、`risk_level: medium`）、`internal-finance-api`（`native_xaa`、`risk_level: high`）、`stub-saas-calendar`（`oauth_bridge`、`risk_level: low`）。
- `tools.yaml` に8件を書く。Document の4件は `internal-docs-api`、Finance の3件は `internal-finance-api`、`stub.calendar.events.list` は `stub-saas-calendar` に紐づける。
- 各 Tool の `xaa_audience` / `xaa_resource` / `api_base_url` は YAML では `${docs_as_issuer}` のようなプレースホルダで書き、投入ジョブが GCS の `platform_endpoints` オブジェクトを読んで置換する。
- 置換後に未解決のプレースホルダが1つでも残ったら、Firestore へ1件も書かずに終了コード1で終わる。
- `stub-saas-calendar` とその Tool は、`platform_endpoints.enable_google_bridge` が false のとき `enabled: false` として書き込む（DEC-SCOPE-04）。
- 投入は `tool_id` / `connector_id` をドキュメント ID にした upsert とし、YAML に存在しない既存ドキュメントは削除する。
- 投入前に全行を T-PROV-01 の Ajv スキーマと `assertCapabilityIdShape` で検証し、違反があれば非ゼロ終了する。
- `internal.finance.payment.approve` の `constraints` に `max_amount` のキーを持たせ、既定値は入れず Policy Engine 由来の値で上書きされる前提にする。
- 投入ジョブは Cloud Run Job として `make seed` から起動する。ジョブの中で terraform コマンドを実行しない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/seed.spec.ts` が緑になり、Firestore エミュレータ上で `catalog_tools` が8件、`catalog_connectors` が3件になることを assert している
- [ ] プレースホルダを1つ未解決にした `platform_endpoints` を与えると終了コード1で終わり、`catalog_tools` の件数が0のままであるテストが通る
- [ ] `enable_google_bridge: false` の `platform_endpoints` で投入すると `catalog_tools/stub.calendar.events.list` の `enabled` が false になるテストが通る
- [ ] 不正な Capability 名を含む YAML を与えると非ゼロ終了するテストが通る

---

### T-PROV-03 Catalog Repository を実装しエンドポイントの直書きを検査する

**概要**
Provisioner が Tool を解決する経路を Catalog Repository 1本に集約する。
Provisioner のコードに Resource の URL や HTTP メソッドを直書きしない（RULE-16）。
あわせて `risk_level` の用途を監査とUI表示に限定し、Isolation Level の決定に使わせない。

**対象要件** REQ-01-013, REQ-04-027
**前提タスク** T-PROV-01
**成果物**
- `apps/provisioner/src/catalog/repository.ts`
- `apps/provisioner/test/catalog-repository.spec.ts`
- `scripts/check-no-hardcoded-endpoint.sh`
- `scripts/check-risk-level-usage.sh`

**実装方針**
- Repository の公開関数は `findToolsByCapability(capabilityId)` / `findToolById(toolId)` / `findConnectorById(connectorId)` の3つに限る。
- いずれも `enabled === false` のドキュメントを結果から除外する。
- 読み取りは `packages/gcp/src/firestore-guard.ts` の許可マトリクスに `provisioner -> catalog_tools`（read）と `provisioner -> catalog_connectors`（read）を追加して行う。書き込みの許可は与えない。
- `scripts/check-no-hardcoded-endpoint.sh` は `apps/provisioner/src` に対して `grep -rn "https://"` を実行し、`platform_endpoints` の型定義ファイルと `seed/` を除いて1件も無いことを検査する。
- `scripts/check-risk-level-usage.sh` は `grep -rn "risk_level" apps/provisioner/src` の結果から、`isolation_level` を含む行が0件であることを検査する。
- `risk_level` は Activity Event と構造化ログへそのまま載せるだけにする。Provisioner 内で比較や分岐に使わない。
- 両スクリプトを `pnpm lint:rules` に登録し、CI から実行する。

**完了条件**
- [ ] `bash scripts/check-no-hardcoded-endpoint.sh` が終了コード0で通る
- [ ] `bash scripts/check-risk-level-usage.sh` が終了コード0で通る
- [ ] `pnpm vitest run apps/provisioner/test/catalog-repository.spec.ts` が緑になり、`enabled: false` の Tool が `findToolsByCapability` の結果に含まれないことを assert している
- [ ] `risk_level: high` の Tool を含む `isolation_level: standard` の Agent が standard のまま Provision される統合テストが緑になる

---

### T-PROV-04 Effective Capability から Allowed Tools を解決する

**概要**
Effective Capability の配列を入力に、Catalog を引いて Allowed Tools を確定する（docs 04 §5）。
1つの Capability に複数 Tool が対応する場合は全件を含める。
解決できる Tool が1つも無い Capability があれば Provisioning を中止する。

**対象要件** REQ-04-011
**前提タスク** T-PROV-03
**成果物**
- `apps/provisioner/src/catalog/resolve-tools.ts`
- `apps/provisioner/test/resolve-tools.spec.ts`

**実装方針**
- 関数は `resolveAllowedTools(capabilities: CapabilityId[]): Promise<ResolveResult>` とする。
- 戻り値は成功時 `{ ok: true, tools: CatalogTool[], connectorIds: ConnectorId[] }`、失敗時 `{ ok: false, code: "no_tool_for_capability", capability_id: CapabilityId }` の判別可能ユニオンにする。例外を投げない。
- 失敗した Capability が複数ある場合は、入力配列の順で最初の1件を `capability_id` に入れる。
- 結果の `tools` は `tool_id` の昇順で安定ソートし、重複を排除する。
- `connectorIds` は解決した Tool の `connector_id` の重複排除集合とする。これが REQ-07-006 の `required_connectors` になる。
- 呼び出し側は `ok: false` のとき Provisioning Transaction を `FAILED` にし、`pending_step` に `resolve_tools` を残して Agent ID を生成しない。
- `document.read` は `internal.document.list` と `internal.document.get` の2件に解決される。`finance.payment.approve` は `internal.finance.payment.approve` の1件に解決される。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/resolve-tools.spec.ts` が緑になり、`[document.read, document.write]` が4件の `internal.document.*` に解決されることを assert している
- [ ] Tool の無い Capability（既定構成の `mail.message.send`）を渡すと `{ ok: false, code: "no_tool_for_capability", capability_id: "mail.message.send" }` が返るテストが通る
- [ ] 解決に失敗したとき `agents` コレクションに新規ドキュメントが増えず、Transaction が `FAILED` になる統合テストが緑になる
- [ ] 同じ入力を2回渡すと `tools` の配列順が一致することを assert するテストが通る

---

### T-PROV-05 XAA 静的設定（audience / resource / scope）を生成する

**概要**
Allowed Tools から audience と resource と scope の3集合を重複排除して生成する（RULE-19）。
Tool に現れない値を1つも含めない。
resource は RFC 8707 の絶対 URI とし、fragment を持たせない（DEC-ID-05）。

**対象要件** REQ-04-012, REQ-05-065, REQ-07-006
**前提タスク** T-PROV-04
**成果物**
- `apps/provisioner/src/catalog/build-xaa-config.ts`
- `apps/provisioner/test/build-xaa-config.spec.ts`

**実装方針**
- 関数は `buildXaaConfig(tools: CatalogTool[]): XaaStaticConfig` とし、戻り値は `{ allowed_audiences: string[], resources: string[], scopes: string[] }` の3キーのみとする。
- `allowed_audiences` は各 Tool の `xaa_audience`、`resources` は `xaa_resource`、`scopes` は `xaa_scope` の重複排除集合とし、いずれも辞書順に安定ソートする。
- Native XAA の Tool では `xaa_audience` が Resource AS の issuer、`xaa_resource` が Resource API の絶対 URI になる。Bridge の Tool では `xaa_audience` が Bridge の issuer になる。
- `allowed_audiences` と `resources` の全要素を `new URL()` で解析し、`protocol === "https:"` かつ `hash === ""` を満たさなければ `invalid_xaa_config` を投げる。
- `scopes` の全要素が `RESOURCE_SCOPES` に含まれることを検査し、含まれなければ `invalid_xaa_config` を投げる。
- 生成した3集合は Agent Registration と Tool Manifest と Job Execution の env の3か所へ同じ値を渡す。3か所で別々に組み立てない。
- Provisioning 完了後にこの3集合を変更する関数を実装しない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/build-xaa-config.spec.ts` が緑になり、Document の4 Tool から `scopes === ["docs.read", "docs.write"]`、`resources` が1件になることを assert している
- [ ] `document.read` のみの入力から `scopes === ["docs.read"]` が導かれ、`docs.write` が含まれないテストが通る
- [ ] `xaa_resource` に fragment 付き URI を持つ Tool を渡すと `invalid_xaa_config` が投げられるテストが通る
- [ ] Registration と Tool Manifest と Job env の3集合が一致することを assert する統合テストが緑になる

---

### T-PROV-06 Tool Manifest を生成する

**概要**
Allowed Tools から Agent Runtime 向けの Tool Manifest を生成する（docs 04 §5）。
Manifest には API の技術情報を載せる一方、Client Secret と Refresh Token と OAuth Client 情報を1つも載せない（RULE-22）。

**対象要件** REQ-04-013
**前提タスク** T-PROV-04, T-PROV-05
**成果物**
- `apps/provisioner/src/catalog/build-manifest.ts`
- `packages/xaa-contracts/src/schemas/tool-manifest.schema.json`
- `apps/provisioner/test/build-manifest.spec.ts`

**実装方針**
- Manifest の最上位は `{ agent_id, expires_at, tools[] }` の3キーに固定する。
- `tools[]` の各要素は `tool_id` / `description` / `required_capability` / `authorization{ audience, resource, scope }` / `token_provider` / `api{ base_url, method, path }` / `parameters` / `constraints` / `response_schema` の9キーに固定する。
- `token_provider` は Connector の `resource_type` から導き、`native_xaa` なら `resource_as`、`oauth_bridge` なら `bridge` の2値のみを取る。
- 生成後に Manifest 全体を再帰的に走査し、キー名が `secret` / `client_secret` / `refresh_token` / `private` / `d` のいずれかに一致する要素があれば `manifest_contains_secret` を投げる。この検査は生成関数の中で必ず実行する。
- Manifest は JSON 文字列化して Job Execution の env `TOOL_MANIFEST_JSON` として渡す。Firestore にも Secret Manager にも保存しない。
- `constraints` は Catalog の値に、Policy Engine が `authorization_decisions` に残した `added_constraint`（`max_amount` など）をマージする。マージは Tool 単位で行い、Catalog 側に無いキーは追加しない。
- Manifest を Provisioning 後に更新する関数を実装しない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/build-manifest.spec.ts` が緑になり、生成した Manifest の全キーを再帰列挙した結果に `secret` / `client_secret` / `refresh_token` / `d` が1つも無いことを assert している
- [ ] `internal.finance.payment.approve` の `constraints.max_amount` が `added_constraint` の値で埋まることを assert するテストが通る
- [ ] 生成した Manifest が `tool-manifest.schema.json` の Ajv 検証を通り、未知キーを追加すると検証に失敗するテストが通る
- [ ] Agent Runtime が `TOOL_MANIFEST_JSON` を読み込んで Allowed Tools を復元できる統合テストが緑になる

---

### T-PROV-07 Agent Registration へ書くキーを限定する

**概要**
Agent OP は Tool の技術情報を持たない（RULE-16、RULE-20）。
Registration へ書くのは audience と resource と scope の3集合だけで、`api_base_url` や `tool_id` を書かない。
あわせて `issuer` と `subject` のフィールドを定義しない（RULE-46）。

**対象要件** REQ-04-014, REQ-05-040
**前提タスク** T-PROV-05
**成果物**
- `packages/xaa-contracts/src/schemas/agent-registration.schema.json`
- `apps/provisioner/test/registration-keys.spec.ts`

**実装方針**
- スキーマの `properties` は `agent_id` / `human_subject` / `client_auth` / `idp_connection_id` / `allowed_audiences` / `resources` / `scopes` / `created_at` / `expires_at` / `status` / `dedicated_op` の11件のみとする。
- `dedicated_op` は boolean とし、STANDARD では false を書く。Cleanup が Dedicated OP 一式の削除を要するかの判定に使うため、docs 05 §4 の10キーへこれ1件だけを追加する。
- `additionalProperties: false` を指定し、`api_base_url` / `api_method` / `api_path` / `tool_id` / `description` / `issuer` / `subject` を書き込もうとすると Ajv 検証で失敗させる。
- `client_auth` の `properties` は `method`（定数 `client_assertion_jwt`）/ `jwk_thumbprint` / `public_jwk` の3件に固定する。`public_jwk` は EC 公開鍵の `kty` / `crv` / `x` / `y` / `kid` / `alg` / `use` のみを許し、`d` を持つ場合は検証に失敗させる。
- スナップショットテストで Firestore へ書かれたドキュメントのキー集合を配列として固定する。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/registration-keys.spec.ts` が緑になり、キー集合のスナップショットが上記11件と完全一致する
- [ ] `agent-registration.schema.json` に `issuer` と `subject` のキーが存在しないことを assert するテストが通る
- [ ] `d` を含む JWK を `client_auth.public_jwk` に入れると Ajv 検証に失敗するテストが通る
- [ ] `api_base_url` を追加したドキュメントが Ajv 検証に失敗するテストが通る

---

### T-PROV-08 Provisioner アプリの骨格と Human Access Token 検証を実装する

**概要**
Provisioner を Hono アプリとして立ち上げ、Human Access Token と DPoP Proof の検証ミドルウェアを置く。
`aud` に `agent-provisioner` が含まれないトークンで Provisioner を呼べないようにする（docs 05 §1）。
`aud` は複数要素になりうるため、要素として含まれるかで判定する（DEV-12）。

**対象要件** REQ-05-011
**前提タスク** なし
**成果物**
- `apps/provisioner/src/index.ts`
- `apps/provisioner/src/config.ts`
- `apps/provisioner/src/middleware/human-token.ts`
- `apps/provisioner/test/human-token.spec.ts`

**実装方針**
- `apps/provisioner/src/index.ts` は `createApp(): Hono` を default export する（DEC-APP-07）。HTTP の listen は `src/server.ts` に分ける。
- ミドルウェア `humanToken()` の検証順序を、署名検証 → `typ === "at+jwt"` → `iss` 一致 → `exp` と `nbf` → `aud` の要素一致 → `scope` に `agent:provision` が含まれるか → DPoP Proof 署名 → `cnf.jkt` と Proof 鍵 thumbprint の一致 → `htm` と `htu` → `iat` 窓 → `jti` 重複、に固定する。
- `aud` 判定は `packages/xaa-contracts/src/audience.ts` の `audienceIncludes(aud, "agent-provisioner")` を使い、前方一致と部分一致を使わない。
- `typ` が `at+jwt` 以外なら 401 を返す（DEC-ID-18）。
- DPoP の検証関数は `packages/xaa-crypto/src/dpop.ts` の `verifyDpopProof` を import して使う。自前で再実装しない。
- 失敗時の応答は署名と `typ` と `iss` と `exp` の失敗が 401、`aud` と `scope` の失敗が 403、DPoP 関連の失敗が 401 とし、`WWW-Authenticate: DPoP error="invalid_token"` を付ける。
- 検証結果は `c.set("humanSubject", payload.sub)` と `c.set("tokenJkt", jkt)` で後続へ渡す。ハンドラが生のトークンを再度参照しない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/human-token.spec.ts` が緑になり、`aud: ["authorization-platform"]` のトークンで `POST /provisioning` が 403 になることを assert している
- [ ] `aud: ["agent-provisioner", "https://human-idp.../userinfo"]` のトークンが通り、`aud: ["agent-provisioner-x"]` が 403 になるテストが通る
- [ ] `typ: "oauth-id-jag+jwt"` のトークンが 401 になるテストが通る
- [ ] `scope` に `agent:provision` を含まないトークンが 403 になるテストが通る

---

### T-PROV-09 human_subject を Access Token の sub から確定する

**概要**
Control Plane API の `human_subject` は Access Token の `sub` を正とする（RULE-43）。
ボディの `human_subject` は照合にのみ使い、後続処理では読まない。
Provisioner は ingress=INTERNAL であり、Automation App と Lifecycle Manager からのみ呼ばれる。

**対象要件** REQ-05-015, REQ-08-048
**前提タスク** T-PROV-08
**成果物**
- `apps/provisioner/src/middleware/subject-binding.ts`
- `apps/provisioner/test/subject-binding.spec.ts`

**実装方針**
- ミドルウェア `subjectBinding()` は、ボディに `human_subject` が存在し `c.get("humanSubject")` と一致しなければ 403 と `{ error: "subject_mismatch" }` を返す。
- 一致した場合もボディの値を捨て、以降のハンドラは `c.get("humanSubject")` だけを参照する。ハンドラが `body.human_subject` を読むことを ESLint の `no-restricted-syntax` ルールで禁止する。
- Agent Registration の `human_subject` には必ず `c.get("humanSubject")` を書く。
- Provisioner の ingress 設定と `run.invoker` の限定は Infra 側で行う。ここでは、`X-Forwarded-For` などのヘッダから呼び出し元を推定する分岐を実装しないことを規約とする。
- 403 のときは Provisioning Transaction を作らない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/subject-binding.spec.ts` が緑になり、`sub=user-a` のトークンでボディに `human_subject=user-b` を送ると 403 と `subject_mismatch` が返ることを assert している
- [ ] `sub=user-a` のトークンでボディに `human_subject=user-a` を送って成功したとき、`agents/{agent_id}.human_subject === "user-a"` になる統合テストが緑になる
- [ ] `grep -rn "body.human_subject\|\.human_subject" apps/provisioner/src/routes` の結果が0件である
- [ ] 403 応答の後に `provisioning_transactions` の件数が増えないテストが通る

---

### T-PROV-10 Agent Definition のスキーマ検証を実装する

**概要**
`POST /provisioning` が受け取る Agent Definition を厳格スキーマで検証する（docs 02 §4）。
Isolation Level は2値に固定し、`DEDICATED_IDENTITY` を実装しない（RULE-30）。

**対象要件** REQ-02-016, REQ-05-055
**前提タスク** T-PROV-08
**成果物**
- `packages/xaa-contracts/src/schemas/agent-definition.schema.json`
- `apps/provisioner/src/routes/provisioning.ts`
- `apps/provisioner/test/agent-definition.spec.ts`

**実装方針**
- 必須フィールドは `agent_purpose` / `human_subject` / `work_definition.description` / `work_definition.operations[]` / `effective_capabilities[]` / `lifetime.max_hours` / `security_profile.isolation_level` / `decision_id` の8件とする。
- `lifetime.max_hours` は `integer`、`minimum: 1`、`maximum: 24`。
- `security_profile.isolation_level` は enum `["standard", "full_isolation"]` とし、ワイヤ形式は小文字に固定する。TypeScript の型は `type IsolationLevel = "standard" | "full_isolation"` の2要素 union にする。
- `effective_capabilities[]` の要素は `CAPABILITY_IDS` の enum とし、`minItems: 1`、`uniqueItems: true`。
- `additionalProperties: false` を最上位と全てのオブジェクトに指定する。未知フィールドは 400。
- Ajv のエラーを HTTP 応答へ変換する `mapValidationError` を置き、`instancePath === "/security_profile/isolation_level"` の enum 違反だけは `{ error: "invalid_isolation_level" }` に写像する。それ以外は `{ error: "invalid_agent_definition", details: [...] }` とする。
- `DEDICATED_IDENTITY` を扱う分岐、定数、型を実装しない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/agent-definition.spec.ts` が緑になり、docs 02 §4 の `daily_schedule_notification` と `financial_operation` の2例に `decision_id` を付けたペイロードが検証を通る
- [ ] `lifetime.max_hours: 25` が 400 `invalid_agent_definition` になるテストが通る
- [ ] `security_profile.isolation_level: "DEDICATED_IDENTITY"` が 400 `invalid_isolation_level` になるテストが通る
- [ ] 未知フィールド `foo` を足すと 400 になるテストが通る

---

### T-PROV-11 decision_id から Effective Capability と Isolation Level を再取得して照合する

**概要**
Authorization Platform の決定を Automation App 経由で受け取るため、ボディの値を信頼しない（RULE-10、RULE-43）。
`decision_id` で Authorization DB を引き直し、集合として一致するかを検証する。
以降の処理は DB から取得した値だけを使う。

**対象要件** REQ-02-017
**前提タスク** T-PROV-10
**成果物**
- `apps/provisioner/src/authz/decision.ts`
- `apps/provisioner/test/decision-match.spec.ts`

**実装方針**
- `loadDecision(decisionId)` は Firestore の `authorization_decisions/{decision_id}` を読み、`{ human_subject, effective_capabilities, isolation_level, added_constraints }` を返す。読み取り権限は `packages/gcp/src/firestore-guard.ts` の許可マトリクスへ `provisioner -> authorization_decisions`（read）として追加する。
- ドキュメントが存在しなければ 404 と `{ error: "decision_not_found" }`。
- `decision.human_subject !== c.get("humanSubject")` なら 403 と `{ error: "decision_owner_mismatch" }`。
- `effective_capabilities` は順序を無視した集合比較で照合する。要素の増減がどちらか一方でもあれば 400 と `{ error: "decision_mismatch", missing: [...], extra: [...] }`。
- `isolation_level` はボディと DB を文字列比較し、不一致なら同じく 400 `decision_mismatch`。
- 照合を通った後は `decision` の値を `c.set("decision", decision)` へ入れ、ボディの `effective_capabilities` と `security_profile` を以降で参照しない。
- 照合失敗時は Provisioning Transaction を作らない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/decision-match.spec.ts` が緑になり、DB が `[document.read]` の決定にボディで `document.write` を足すと 400 `decision_mismatch` が返ることを assert している
- [ ] 他人の `decision_id` を指定すると 403 `decision_owner_mismatch` が返るテストが通る
- [ ] 存在しない `decision_id` で 404 が返るテストが通る
- [ ] 照合失敗時に `provisioning_transactions` の件数が増えないテストが通る

---

### T-PROV-12 Effective Capability ⊆ Human Permission を再検証する

**概要**
Authorization Platform の決定を信頼せず、Provisioner 側でも Human Permission との包含関係を確認する多層防御である（RULE-11）。
1件でも含まれない Capability があれば Provisioning を開始しない。

**対象要件** REQ-01-005
**前提タスク** T-PROV-11
**成果物**
- `apps/provisioner/src/authz/human-permission.ts`
- `apps/provisioner/test/capability-subset.spec.ts`

**実装方針**
- `loadHumanPermissions(humanSubject)` は Firestore の `human_permissions/{human_subject}` を読み、`capabilities: CapabilityId[]` を返す。許可マトリクスへ `provisioner -> human_permissions`（read）を追加する。
- ドキュメントが存在しない場合は空集合として扱い、fail-closed にする。存在しないことを「全許可」と解釈する分岐を作らない。
- `assertSubset(effective, humanPermission)` が包含を満たさないとき、HTTP 400 と `{ error: "capability_not_subset_of_human_permission", capabilities: [...] }` を返す。`capabilities` には含まれなかった Capability を全件入れる。
- 検証は T-PROV-11 の照合の直後、Provisioning Transaction の作成より前に実行する。
- キャッシュを持たない。1リクエストにつき1回読む。
- REQ-01-005 の受入条件案にある `document.content.read` は specs 5.0 で `document.read` に確定したため、テストは `document.read` と `document.write` で書く。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/capability-subset.spec.ts` が緑になり、Human Permission が `[document.read]` のユーザーに `[document.read, document.write]` の Definition を送ると 400 `capability_not_subset_of_human_permission` が返ることを assert している
- [ ] 応答の `capabilities` が `["document.write"]` になるテストが通る
- [ ] `human_permissions` ドキュメントが存在しないユーザーで 400 になるテストが通る
- [ ] 400 応答の後に `provisioning_transactions` の件数が増えないテストが通る

---

### T-PROV-13 Provisioning Transaction のスキーマと状態遷移を実装する

**概要**
Consent による中断から復元するため Provisioning Transaction を持つ（docs 07 §3.2）。
Cloud SQL ではなく Firestore の `provisioning_transactions` コレクションに置く（DEC-IAC-09）。
状態遷移を関数1本に閉じ込め、任意の遷移を書けないようにする。

**対象要件** REQ-07-003
**前提タスク** T-PROV-12
**成果物**
- `apps/provisioner/src/transaction/store.ts`
- `apps/provisioner/src/transaction/state.ts`
- `packages/xaa-contracts/src/schemas/provisioning-transaction.schema.json`
- `apps/provisioner/test/transaction.spec.ts`

**実装方針**
- ドキュメント `provisioning_transactions/{transaction_id}` のフィールドは `transaction_id` / `human_subject` / `agent_id` / `required_capabilities` / `required_connectors` / `isolation_level` / `status` / `pending_step` / `dedicated_short_id` / `created_at` / `expires_at` の11件とする。
- `status` は `CREATED` / `WAITING_IDP_CONSENT` / `WAITING_EXTERNAL_CONSENT` / `RESUMABLE` / `PROVISIONING` / `COMPLETED` / `FAILED` / `ABANDONED` の8値。
- `transaction_id` は `txn_` + 16バイト乱数の base64url とする。
- `expires_at` は `created_at + 30分` で固定する。TTL は環境変数で変えられるようにせず、定数 `TRANSACTION_TTL_SECONDS = 1800` として置く。
- 遷移は `transition(txn, next)` 1本に限り、許可遷移表を定数マップで持つ。表に無い遷移は `invalid_transaction_transition` を投げる。
- `COMPLETED` / `FAILED` / `ABANDONED` は終端とし、そこからの遷移を許可しない。
- Transaction の TTL sweep 本体は Lifecycle 側（T-LIFE）が実装する。ここでは sweep が呼ぶ `abandon(transactionId)` を公開し、その中で Agent Client Credential の公開鍵ドキュメント削除、IdP Connection の revoke 依頼、Isolation Slot の解放を逆順で行う。
- `abandon` は冪等にする。既に `ABANDONED` の Transaction へ再実行しても副作用を起こさない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/transaction.spec.ts` が緑になり、`COMPLETED` から `PROVISIONING` への遷移が `invalid_transaction_transition` を投げることを assert している
- [ ] TTL 経過後に `abandon` を呼ぶと status が `ABANDONED` になり、紐づく IdP Connection への revoke 依頼が1回行われ、Isolation Slot が `FREE` に戻るテストが通る
- [ ] `abandon` を同じ Transaction へ2回呼んでも `dedicated_resources` の状態が変わらないテストが通る
- [ ] 未知フィールドを含むドキュメントが Ajv 検証に失敗するテストが通る

---

### T-PROV-14 検証を Transaction 作成より前に置く順序を固定する

**概要**
docs 07 §3.3 に従い、Token と Proof の検証に通らない要求では DB へ1行も書かない（RULE-43、RULE-44）。
検証と書き込みの順序をコードとテストの両方で固定する。

**対象要件** REQ-07-005
**前提タスク** T-PROV-13
**成果物**
- `apps/provisioner/src/routes/provisioning.ts`
- `apps/provisioner/test/authz-order.spec.ts`

**実装方針**
- `POST /provisioning` のミドルウェア連鎖を `humanToken()` → `subjectBinding()` → `validateAgentDefinition()` → `loadAndMatchDecision()` → `assertCapabilitySubset()` → ハンドラ本体、の順で登録する。
- Transaction の作成はハンドラ本体の先頭に置く。ミドルウェアの中で Firestore へ書かない。
- テスト用に `getWriteCount()` を持つ Firestore ラッパをテストダブルとして用意し、失敗系で書き込み回数が0であることを assert する。
- 検証失敗時の応答は 401（トークン不正）、403（`aud` / `scope` / subject / decision の所有者不一致）、400（スキーマ、`decision_mismatch`、`capability_not_subset_of_human_permission`）のいずれかに揃える。
- 検証を通した後に例外が発生した場合は、Transaction を `FAILED` にしてから 500 を返す。Transaction を作らずに 500 を返す経路を作らない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/authz-order.spec.ts` が緑になり、不正な DPoP Proof を添えた要求の後に `provisioning_transactions` の件数が増えないことを assert している
- [ ] ボディの `human_subject` を他人へ差し替えると 403 になり、書き込み回数が0であるテストが通る
- [ ] 正常系でミドルウェアの実行順が上記6段と一致することを、フックで記録した配列の assert で確認できる
- [ ] `decision_mismatch` の 400 応答時に書き込み回数が0であるテストが通る

---

### T-PROV-15 one-time completion code を実装する

**概要**
Consent からの復帰に使う one-time code を実装する（RULE-23）。
リダイレクトで返すのは `transaction_id` と code だけであり、トークン類を返さない。
再利用は拒否し、Protocol Validation イベントとして記録する。

**対象要件** REQ-07-004
**前提タスク** T-PROV-13
**成果物**
- `apps/provisioner/src/transaction/one-time-code.ts`
- `apps/provisioner/test/one-time-code.spec.ts`

**実装方針**
- 発行は `issueCompletionCode({ transaction_id, human_subject, issuer_kind })` とし、code は 32バイト乱数の base64url とする。
- 保存先は Firestore の `provisioning_codes/{code_hash}`。ドキュメント ID は code の SHA-256 を base64url にしたものにし、平文の code を保存しない。
- フィールドは `code_hash` / `transaction_id` / `human_subject` / `issuer_kind` / `created_at` / `expires_at` / `used_at` の7件。
- `issuer_kind` は `idp` または Connector ID（`internal-docs-api` などの `CONNECTOR_IDS` の値）のいずれかとする。
- TTL は 300 秒の定数 `COMPLETION_CODE_TTL_SECONDS = 300` とする。
- 消費は `consumeCompletionCode({ code, transaction_id, human_subject })` とし、Firestore の `runTransaction` の中で `used_at` の未設定を確認してから書き込む。
- 照合は `crypto.timingSafeEqual` による定数時間比較で行う。ハッシュ値の比較にも文字列の `===` を使わない。
- 失敗の分類は、期限切れが 400 `code_expired`、2回目が 400 `code_already_used`、`transaction_id` 不一致が 400 `code_transaction_mismatch`、`human_subject` 不一致が 403 `code_owner_mismatch` とする。
- `code_already_used` のときは Protocol Validation イベントを Security Detection へ送る。イベントに code の平文とハッシュを含めない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/one-time-code.spec.ts` が緑になり、期限超過と2回目消費と `transaction_id` 不一致と別ユーザーの Access Token の4ケースがそれぞれ 400 / 400 / 400 / 403 になることを assert している
- [ ] 並行に同じ code で `consumeCompletionCode` を10回呼んで成功が1回だけになるテストが通る
- [ ] `provisioning_codes` のドキュメントに平文 code が保存されないことを assert するテストが通る
- [ ] `code_already_used` のとき Protocol Validation イベントが1件送られるテストが通る

---

### T-PROV-16 CONSENT_REQUIRED 中断応答を固定する

**概要**
Provisioner は Internet へ公開しないため、Automation App が Provisioner の URL をブラウザへ出せない（RULE-37）。
中断応答の JSON を1形に固定し、`consent_url` に Provisioner 自身のホストを含めない。

**対象要件** REQ-07-011
**前提タスク** T-PROV-15
**成果物**
- `apps/provisioner/src/transaction/consent-response.ts`
- `packages/xaa-contracts/src/schemas/consent-required.schema.json`
- `apps/provisioner/test/consent-response.spec.ts`

**実装方針**
- 応答の形は `{ status, transaction_id, consent_url, connector_id? }` に固定する。`status` は `IDP_CONSENT_REQUIRED` と `CONSENT_REQUIRED` の2値。
- `IDP_CONSENT_REQUIRED` では `connector_id` を含めない。`CONSENT_REQUIRED` では必須にする。
- `consent_url` は、IdP 側は Human IdP の `/authorize`（`client_id=agent-platform`、`scope=openid offline_access`、`redirect_uri` は Agent OP の `/xaa/callback`）、SaaS 側は Bridge callback サービスの `/{connector_id}/oauth/start` を指す。
- URL のホスト部は `platform_endpoints` から取り、コード内で組み立て直さない。
- 応答を返す前に `new URL(consent_url).host !== 自身のホスト` を検査し、一致する場合は `invalid_consent_url` を投げて 500 にする。
- HTTP ステータスは 200 とし、`status` フィールドで中断を表す。202 や 3xx を使わない。
- Automation App はこの `consent_url` へ 302 するだけとする。App 側で URL を組み立てないことを規約として README に書く。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/consent-response.spec.ts` が緑になり、2種類の応答が `consent-required.schema.json` の Ajv 検証（`additionalProperties: false`）を通ることを assert している
- [ ] `consent_url` のホストが Provisioner のホストと異なることを assert するテストが通る
- [ ] `IDP_CONSENT_REQUIRED` に `connector_id` を付けると Ajv 検証に失敗するテストが通る
- [ ] `consent_url` を自ホストに差し替えると 500 `invalid_consent_url` になるテストが通る

---

### T-PROV-17 Resume Transaction API を実装する

**概要**
Consent から戻ったあと、中断した Provisioning を再開する（docs 07 §3.2、§3.3）。
再開は POST のみで受け、Access Token と one-time code の両方が揃った場合だけ進める。

**対象要件** REQ-07-012
**前提タスク** T-PROV-15, T-PROV-16
**成果物**
- `apps/provisioner/src/routes/resume.ts`
- `apps/provisioner/test/resume.spec.ts`

**実装方針**
- ルートは `POST /provisioning/:transaction_id/resume`。ボディは `{ one_time_code }` の1キーのみとし、`additionalProperties: false`。
- 処理順を (1) `humanToken()` の8項目検証、(2) Transaction の読み出しと `human_subject === sub` の照合、(3) `consumeCompletionCode`、(4) 発行元検証の Server-to-Server 呼び出し、(5) `pending_step` の次段階へ遷移、に固定する。
- (4) は `issuer_kind === "idp"` のとき Agent OP の `POST /internal/idp-connections/{idp_connection_id}/verify`、それ以外のとき Bridge の `POST /connections/verify` を呼ぶ。呼び出しは `packages/xaa-contracts` の `httpClient` を使い、呼び出し元 SA の ID トークンを付ける。
- 検証応答が `READY` 以外なら Transaction の status を変えずに 409 と `{ error: "connection_not_ready" }` を返す。
- 同じルートの GET を明示的に登録し、常に 405 と `Allow: POST` を返す。
- Transaction が終端状態（`COMPLETED` / `FAILED` / `ABANDONED`）のときは 409 と `{ error: "transaction_not_resumable" }`。
- `human_subject` 不一致は 403 とし、one-time code を消費しない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/resume.spec.ts` が緑になり、他ユーザーの Access Token による resume が 403 になり `provisioning_codes` の `used_at` が未設定のままであることを assert している
- [ ] `GET /provisioning/:id/resume` が 405 と `Allow: POST` を返すテストが通る
- [ ] 正常系で status が `WAITING_IDP_CONSENT` から `RESUMABLE` を経て次段階へ進むテストが通る
- [ ] Agent OP の verify が `READY` を返さないとき 409 `connection_not_ready` になり status が変わらないテストが通る

---

### T-PROV-18 Agent Registration の作成を実装する

**概要**
Agent Registration は Isolation Level に関わらず Agent ごとに作る（RULE-03、RULE-31）。
STANDARD で共有するのは Cloud Run Service のプロセスだけであり、Registration と鍵と XAA 設定と IdP Connection は分ける。

**対象要件** REQ-05-038, REQ-05-039
**前提タスク** T-PROV-07, T-PROV-05
**成果物**
- `apps/provisioner/src/agent/registration.ts`
- `apps/provisioner/test/registration.spec.ts`

**実装方針**
- `createAgentRegistration(input)` は Firestore `agents/{agent_id}` へ1ドキュメントを作成する。既存 ID があれば `agent_already_exists` を投げ、上書きしない。
- `agent_id` は `agent_` + 16バイト乱数の base64url とする。決定的な連番にしない。
- `status` は `ACTIVE` / `REVOKED` / `EXPIRED` の3値。作成時は `ACTIVE`。docs 07 §2 の他の状態は Lifecycle 側が別フィールドで持ち、Registration の `status` を4値以上にしない。
- 書き込み前に T-PROV-07 の Ajv スキーマで検証し、失敗したら書き込まない。
- STANDARD でも `dedicated_op` に null を明示的に書く。フィールドを省略しない。
- `idp_connection_id` は Agent OP が作成した Connection の ID を受け取って書く。Provisioner 側で生成しない。
- 同一 `human_subject` に対する Registration 数の上限をここでは設けない。上限は Lifecycle 側の関心とする。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/registration.spec.ts` が緑になり、必須項目欠落と未知フィールドが Ajv 検証で弾かれることを assert している
- [ ] STANDARD の Agent を2体作ると `agents` が2ドキュメント、`idp_connections` が2レコードになり、`client_auth.jwk_thumbprint` が2種類になる統合テストが緑になる
- [ ] 同じ `agent_id` で2回呼ぶと `agent_already_exists` が投げられ、既存ドキュメントが変化しないテストが通る
- [ ] Provisioner が作成した Registration を Agent OP が読み出せる統合テストが緑になる

---

### T-PROV-19 Registration の更新経路を封じる

**概要**
docs 07 §5 と §7 の「更新するより捨てて作り直す」を構成で強制する（RULE-29、RULE-13）。
`agents/{agent_id}` への書き込みを作成と status 遷移と削除の3操作に限る。

**対象要件** REQ-07-034
**前提タスク** T-PROV-18
**成果物**
- `apps/provisioner/src/agent/registration-writer.ts`
- `apps/provisioner/test/registration-immutability.spec.ts`

**実装方針**
- `agents` コレクションへの書き込みは `registration-writer.ts` の `createRegistration` / `transitionStatus` / `deleteRegistration` の3関数のみを通す。
- `firestore-guard.ts` の許可マトリクスで、`agents` パスへの書き込みをこのモジュールからの呼び出しに限定する。他モジュールからの `set` / `update` は `forbidden_registration_write` を投げる。
- `transitionStatus(agentId, next)` は `ACTIVE -> REVOKED` と `ACTIVE -> EXPIRED` の2遷移のみを許可し、それ以外は `invalid_status_transition` を投げる。
- `allowed_audiences` / `resources` / `scopes` / `expires_at` / `human_subject` / `client_auth` / `dedicated_op` を引数に取る更新関数を実装しない。
- モジュールの export 一覧をスナップショットテストで固定し、更新系の関数が増えたら失敗させる。
- Agent OP 側にも同じ制約を課すため、Agent OP は `agents` を read-only で読む。書き込み権限を許可マトリクスに追加しない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/registration-immutability.spec.ts` が緑になり、`registration-writer.ts` の export 一覧スナップショットが3関数と一致する
- [ ] `scopes` を更新しようとするとラッパが `forbidden_registration_write` を投げるテストが通る
- [ ] `REVOKED -> ACTIVE` の遷移が `invalid_status_transition` を投げるテストが通る
- [ ] `grep -rn "collection('agents')\|collection(\"agents\")" apps/provisioner/src` の結果が `registration-writer.ts` のみである

---

### T-PROV-20 expires_at を算出して上限をクランプする

**概要**
Agent の最大生存期間を24時間に固定する（RULE-25）。
環境変数がそれを超える値を持っていても、コード側でクランプする。
検証用途では短い値を Terraform 変数から与える（DEC-IAC-16）。

**対象要件** REQ-07-001
**前提タスク** T-PROV-18
**成果物**
- `apps/provisioner/src/agent/expires-at.ts`
- `apps/provisioner/test/lifetime.spec.ts`

**実装方針**
- `computeExpiresAt(now, requestedHours, maxLifetimeSeconds)` を実装し、`now + min(requestedHours * 3600, maxLifetimeSeconds, HARD_CAP_SECONDS)` を返す。
- `HARD_CAP_SECONDS = 86400` を定数として置き、環境変数から上書きできないようにする。
- `maxLifetimeSeconds` は環境変数 `AGENT_MAX_LIFETIME_SECONDS` から読み、Terraform 変数 `agent_max_lifetime_seconds` が値の出どころになる。既定は 86400、検証プロファイルは 3600。
- `requestedHours` が1未満または24超の場合はスキーマ検証で既に弾かれているため、ここでは再度の範囲チェックを行わずクランプだけを行う。
- 戻り値は RFC 3339 の UTC 文字列とし、秒の小数部を持たせない。
- `expires_at` を受け取って書き換える関数を実装しない。`updateExpiresAt` のような名前の export を作らない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/lifetime.spec.ts` が緑になり、`AGENT_MAX_LIFETIME_SECONDS=172800` を与えても `expires_at - created_at === 86400` になることを assert している
- [ ] `requestedHours=1` と `AGENT_MAX_LIFETIME_SECONDS=3600` で `expires_at - created_at === 3600` になるテストが通る
- [ ] `expires-at.ts` の export 一覧に `expires_at` を引数に取る関数が存在しないことを assert するスナップショットテストが通る
- [ ] 戻り値が `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/` に一致するテストが通る

---

### T-PROV-21 Registration と IdP Connection と Agent Binding の expires_at を一致させる

**概要**
Lifetime を Cloud Run の timeout だけに依存させない（RULE-26）。
Connection 層でも同じ期限を持たせ、3か所の値を秒単位で揃える。

**対象要件** REQ-07-018
**前提タスク** T-PROV-20
**成果物**
- `apps/provisioner/src/agent/lifetime-propagation.ts`
- `apps/provisioner/test/lifetime-consistency.spec.ts`
- `e2e/test/lifetime-consistency.spec.ts`

**実装方針**
- `computeExpiresAt` の戻り値を1つの変数に保持し、Registration の `expires_at`、Agent OP への IdP Connection 作成要求の `expires_at`、Bridge への Agent Binding 作成要求の `expires_at` の3か所へ同じ文字列を渡す。
- 各要求のボディを組み立てる関数の引数を `{ agentId, expiresAt }` に揃え、呼び出し側で再計算しない。
- Agent OP と Bridge は受信時に `expires_at > now + 86400` の作成要求を 400 で拒否する。その拒否の実装は各領域（T-OP、Bridge）が行うが、Provisioner 側の統合テストではその 400 を受けて Provisioning が `FAILED` になることを確認する。
- Bridge の Connection（人間ごと）は別概念であり、この期限を書き込まない。Connection のフィールドを触る経路を Provisioner に作らない。
- Cloud Run Job の `task_timeout` は Terraform 変数 `agent_max_lifetime_seconds` から導出され、Provisioner は Execution 起動時に timeout を上書きしない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/lifetime-consistency.spec.ts` が緑になり、3か所へ渡した `expires_at` の文字列が完全一致することを assert している
- [ ] `e2e/test/lifetime-consistency.spec.ts` で Provisioning 完了後の Registration と `idp_connections` と `agent_bindings` の `expires_at` が秒単位で一致することを assert する
- [ ] Agent OP が 400 を返したとき Transaction が `FAILED` になる統合テストが緑になる
- [ ] Provisioner のソースに Bridge Connection（人間ごと）への書き込み呼び出しが0件であることを grep で確認できる

---

### T-PROV-22 Agent Client Credential を生成し Execution へ渡す

**概要**
Agent ごとに ES256 鍵ペアを生成し、公開鍵だけを Registration に登録する（docs 05 §4）。
秘密鍵は Cloud Run Job Execution の env オーバーライドで当該 Execution にだけ渡し、どこにも永続化しない（RULE-22、RULE-38）。

**対象要件** REQ-05-042, REQ-07-007, REQ-08-033
**前提タスク** T-PROV-18
**成果物**
- `apps/provisioner/src/agent/client-credential.ts`
- `apps/provisioner/test/client-credential.spec.ts`
- `scripts/check-no-private-key-persist.sh`

**実装方針**
- 鍵生成は WebCrypto の `crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])` で行う。KMS を使わない。
- 公開鍵 JWK と RFC 7638 thumbprint を `packages/xaa-crypto/src/thumbprint.ts` の `jwkThumbprint` で計算し、Registration の `client_auth.public_jwk` と `client_auth.jwk_thumbprint` へ書く。
- `client_auth.method` は定数 `client_assertion_jwt` とする（DEC-ID-11）。`private_key_jwt` という文字列を使わない。
- 秘密鍵 JWK は関数の戻り値としてのみ返し、`{ privateJwk }` を持つオブジェクトを Firestore へ渡すコードを作らない。
- Job Execution 起動後に、秘密鍵を保持していた変数へ `undefined` を代入し、参照を切る。ログとエラーメッセージへ鍵を載せない。
- Provisioner の HTTP 応答に秘密鍵を含めない。応答は `{ agent_id, expires_at, status }` の3キーに限る。
- `scripts/check-no-private-key-persist.sh` は、`apps/provisioner/src` に対して Secret Manager クライアントの import と、`privateJwk` を含む変数を Firestore の `set` / `update` へ渡す呼び出しが0件であることを検査する。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/client-credential.spec.ts` が緑になり、Firestore へ書かれた `agents/{agent_id}` のドキュメントを再帰走査して `d` キーが存在しないことを assert している
- [ ] Job Execution の env に `AGENT_CLIENT_PRIVATE_JWK` が存在することを assert する統合テストが緑になる
- [ ] Provisioner の 201 応答の JSON キー集合が `["agent_id", "expires_at", "status"]` と一致するテストが通る
- [ ] `bash scripts/check-no-private-key-persist.sh` が終了コード0で通る

---

### T-PROV-23 Human IdP Connection の作成依頼を内部呼び出しで行う

**概要**
Refresh Token を保持するのは Agent OP だけである（RULE-51）。
Provisioner は Connection の作成を依頼し、その状態を確認するだけで、Refresh Token 本体を持つ期間を作らない。

**対象要件** REQ-05-049
**前提タスク** T-PROV-16
**成果物**
- `apps/provisioner/src/agent/idp-connection.ts`
- `apps/provisioner/test/idp-connection.spec.ts`
- `scripts/check-no-token-endpoint-call.sh`

**実装方針**
- `requestIdpConnection({ agentId, humanSubject, expiresAt, transactionId })` は Agent OP の `POST /internal/idp-connections` を呼び、`{ idp_connection_id, status }` を受け取る。
- 呼び出しは `packages/xaa-contracts` の `httpClient` を使い、Cloud Run の内部 URL と呼び出し元 SA の ID トークンで認証する。ブラウザ経由の経路を作らない。
- Consent の往復は Agent OP の `/xaa/callback` が受け、Refresh Token の取得と暗号化も Agent OP が行う。Provisioner は `code` も `refresh_token` も受け取らない。
- `verifyIdpConnection(idpConnectionId)` は `POST /internal/idp-connections/{id}/verify` を呼び、`READY` かどうかだけを返す。
- Provisioner のソースに Human IdP の `/token` エンドポイントを呼ぶコードを置かない。`scripts/check-no-token-endpoint-call.sh` が `grep -rn "/token" apps/provisioner/src` の結果に Human IdP のホストを伴う行が無いことを検査する。
- Connection 作成に使う `expires_at` は T-PROV-21 の1つの値を渡す。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/idp-connection.spec.ts` が緑になり、Connection 作成要求が内部 URL への POST であり `Authorization` に SA の ID トークンが載ることを assert している
- [ ] `bash scripts/check-no-token-endpoint-call.sh` が終了コード0で通る
- [ ] Provisioner の関数の戻り値と引数の型に `refresh_token` が現れないことを assert する型テストが通る
- [ ] `verifyIdpConnection` が `READY` 以外を返したとき Provisioning が次段階へ進まない統合テストが緑になる

---

### T-PROV-24 Dedicated OP 一式を実行時に作成する

**概要**
FULL_ISOLATION の Agent に対して、専用の Agent OP と署名鍵と Service Account と Runtime Job を Provisioning 時に作る（DEC-IAC-07）。
docs 07 §3.3 の「FULL_ISOLATION では Agent Creation = Dedicated Infrastructure Provisioning」をそのまま実装する。
作ったものは台帳へ記録し、Cleanup と掃除がその台帳だけを見て消せるようにする。

**対象要件** REQ-01-011, REQ-05-057, REQ-07-014, REQ-08-008
**前提タスク** T-PROV-13, T-IAC-14
**成果物**
- `apps/provisioner/src/dedicated.ts`
- `apps/provisioner/src/dedicated-names.ts`
- `apps/provisioner/test/dedicated.spec.ts`
- `infra/tests/runtime-mutation-scope.sh`

**実装方針**
- `dedicated-names.ts` に `shortId(agentId)` を置く。
  `agent_id` の乱数部の末尾12文字を返し、名前はすべてこの値から組み立てる。
  作る名前は `dedicated-op-<short>`、`sa-op-<short>`、`idjag-<short>`、`idpconn-<short>`、`agent-runtime-<short>`、`sa-agent-<short>` の6つに固定する。
  Service Account の `account_id` は6文字以上30文字以内という GCP の制限があるため、`sa-op-<short>` は18文字、`sa-agent-<short>` は21文字に収まる。
- 作成順序を固定する。
  (1) `sa-op-<short>` を作る。
  (2) `sa-agent-<short>` を作る。
  (3) `idjag-<short>` を `idjag-signing` Key Ring に `EC_SIGN_P256_SHA256` で作る。
  (4) `idpconn-<short>` を `idp-connection-encryption` Key Ring に `ENCRYPT_DECRYPT` で作る。
  (5) `packages/xaa-contracts/src/dedicated-iam.ts` の定数だけを使って IAM Binding を張る。
  (6) `dedicated-op-<short>` を Cloud Run Service として作る。ingress は INTERNAL、SA は `sa-op-<short>`、env は `AGENT_ID` ではなく `AGENT_ID` と `IDJAG_KMS_KEY` と `IDP_CONNECTION_KMS_KEY` を渡す。
  (7) `agent-runtime-<short>` を Cloud Run Job として作る。SA は `sa-agent-<short>`、`task_timeout` は Agent の `expires_at` までの残り秒。
  各段の完了ごとに `dedicated_resources/{agent_id}` の `created[]` へ完全修飾名を追記する。
- 作成するすべてのリソースにラベル `xaa-managed=runtime` と `xaa-agent-id=<agent_id>` を付ける（DEC-IAC-25）。
  ラベルを付けられない Service Account には `description` へ `xaa-managed=runtime agent=<agent_id>` を書く。
- 触れてよい名前を1か所でガードする。
  `assertRuntimeName(name)` を `dedicated-names.ts` に置き、`dedicated-op-` / `sa-op-` / `sa-agent-` / `idjag-` / `idpconn-` / `agent-runtime-` の6接頭辞のいずれかで始まらない名前を渡したら例外にする。
  GCP の作成呼び出しは必ずこの関数を通す。
- IAM のロール名をこのファイルへ直書きしない。
  `dedicated-iam.ts` の定数を import して使う。
- IAM の反映には最大数分の遅延がある。
  (6) の Cloud Run Service を作った直後に `dedicated-op-<short>` へ health check を1回投げ、成功するまで最大120秒、5秒間隔で待つ。
  120秒を超えたら `dedicated_provisioning_timeout` で失敗させ、逆順の補償（T-PROV-28）へ入る。
- STANDARD の Agent に対してこのモジュールを呼ばない。
  呼び出し口は `isolation_level === 'full_isolation'` の分岐の中だけに置く。
- `infra/tests/runtime-mutation-scope.sh` は `apps/provisioner/src` と `apps/lifecycle-manager/src` を走査し、GCP の作成と削除と更新の呼び出しが `assertRuntimeName` を通る経路にだけ現れることを検査する。
  Terraform 管理の名前（`human-idp` / `shared-agent-op` / `automation-app` など T-IAC-08 の `locals.service_names` の値）が文字列リテラルとして GCP クライアント呼び出しの引数に現れたら失敗させる。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/dedicated.spec.ts` が緑になり、6リソースが上記の順序で作られることを assert している
- [ ] `assertRuntimeName('human-idp')` が例外になり、`assertRuntimeName('dedicated-op-abc123def456')` が例外にならないテストが通る
- [ ] 作成した6リソースすべてに `xaa-managed=runtime` と `xaa-agent-id` が付くことを assert するテストが通る
- [ ] (3) の途中で失敗させたとき、`dedicated_resources/{agent_id}.created` に (1) と (2) の2件だけが残るテストが通る
- [ ] `bash infra/tests/runtime-mutation-scope.sh` が終了コード0で通る
- [ ] `grep -rn "roles/" apps/provisioner/src/dedicated.ts` の結果が `dedicated-iam` の import 行だけになる

---

### T-PROV-25 FULL_ISOLATION の同時実行数の上限で 503 を返す

**概要**
FULL_ISOLATION の Agent 数に上限を置き、上限に達していたら Provisioning Transaction を作らずに 503 を返す（DEC-IAC-23）。
上限を置く理由はコストではなく、Project あたりの Service Account 数の上限（既定100）と、削除した Service Account が30日間その枠を占め続けるという GCP の制限である。

**対象要件** REQ-02-020
**前提タスク** T-PROV-24
**成果物**
- `apps/provisioner/src/routes/provisioning.ts`
- `apps/provisioner/src/capacity.ts`
- `apps/provisioner/test/full-isolation-capacity.spec.ts`

**実装方針**
- 上限値は環境変数 `MAX_FULL_ISOLATION_AGENTS`（T-IAC-13 が Terraform 変数から注入、既定 5）から読む。
  アプリ側に既定値を持たせず、未設定なら起動時に例外で落とす。
- `countActiveFullIsolation()` は `agents` のうち `meta.isolation_level === 'full_isolation'` かつ `meta.status` が `DESTROYED` 以外の件数を返す。
  破棄済みを数えないのは、Service Account の30日枠は掃除で回収されるまで戻らないが、その回収は Lifecycle の責務であり Provisioning を止める理由にはならないためである。
- 確認と確保を `runTransaction` の中で行う。
  件数が上限未満であることの確認、`dedicated_resources/{agent_id}` の作成、`provisioning_transactions/{id}` の作成を同一トランザクションで行う。
  並行要求で上限を超えないことをこのトランザクションで担保する。
- 応答本文は `{ error: "full_isolation_capacity_reached", active: N, capacity: M }` に固定する。
  `dedicated_op_slot_exhausted` と `no_isolation_slot_available` と `slot_unavailable` と `resource_exhausted` は別名として採用しない。
- 上限に達したとき `isolation_level` を `standard` へ書き換えて続行する分岐を実装しない。
- 応答に `Retry-After: 60` を付ける。
- 上限到達は構造化ログへ `event: "full_isolation_capacity_reached"` として出し、Activity Event としては発行しない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/full-isolation-capacity.spec.ts` が緑になり、上限到達時に 503 と `full_isolation_capacity_reached` が返ることを assert している
- [ ] 503 の後に `provisioning_transactions` と `dedicated_resources` の件数がどちらも増えないテストが通る
- [ ] `MAX_FULL_ISOLATION_AGENTS=2` で並行に3件の FULL_ISOLATION 要求を投げても成功が2件を超えないテストが通る
- [ ] `MAX_FULL_ISOLATION_AGENTS` 未設定で起動すると例外になるテストが通る
- [ ] `grep -rn "dedicated_op_slot_exhausted\|no_isolation_slot_available\|slot_unavailable" apps/ packages/` の結果が0件である

---

### T-PROV-26 作成したリソースの台帳を書き出す

**概要**
実行時に作った GCP リソースの完全修飾名を Firestore へ記録する（DEC-IAC-23）。
Cleanup と掃除はこの台帳だけを見て消す対象を決め、名前を組み立て直さない。
作成の途中で落ちても、作れたところまでが台帳に残るため回収できる。

**対象要件** REQ-01-011, REQ-05-057
**前提タスク** T-PROV-24
**成果物**
- `apps/provisioner/src/dedicated-ledger.ts`
- `apps/provisioner/test/dedicated-ledger.spec.ts`

**実装方針**
- コレクションは `dedicated_resources/{agent_id}` に統一する。
  要件に出る `dedicated_op_slots` と `isolation_slots` と `dedicated_slot` は別名として採用しない。
- フィールドは `agent_id` / `status` / `created` / `created_at` / `expires_at` / `last_error` の6件。
  `status` は `CREATING` と `READY` と `FAILED` と `RELEASED` の4値。
- `created` は要素が `{ kind, name, created_at }` の配列とする。
  `kind` は `service_account` / `crypto_key` / `iam_binding` / `cloud_run_service` / `cloud_run_job` の5値。
  `name` は GCP の完全修飾名を入れる。短縮名やテンプレート文字列を入れない。
- 1リソースを作るたびに、その直後に `created` へ1件追記する。
  まとめて最後に書かない。
  途中で落ちたときに何が残っているかを台帳が正しく示すためである。
- 台帳の書き込みは冪等にする。
  同じ `name` の要素を二重に追記しない。
- Lifecycle Manager は `dedicated_resources/{agent_id}.created` を逆順に読んで消す。
  Provisioner はこの台帳を消さない。
  消すのは Lifecycle（T-LIFE-09）だけとする。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/dedicated-ledger.spec.ts` が緑になる
- [ ] 6リソースの作成後に `created` が6件で、`kind` が5種すべてを含むことを assert するテストが通る
- [ ] 同じ `name` を2回追記しても `created` が増えないテストが通る
- [ ] 3件目の作成で失敗させたとき `status` が `FAILED` かつ `created` が2件、`last_error` が空でないことを assert するテストが通る

---

### T-PROV-27 STANDARD 分岐で GCP リソースを作らないことを固定する

**概要**
docs 07 §3.3 の「Agent Creation ≠ Infrastructure Creation」を構成で強制する（RULE-31）。
STANDARD の Agent 生成で Cloud Run Service も Service Account も KMS Key も IAM Binding も作らない。

**対象要件** REQ-07-013, REQ-08-053
**前提タスク** T-PROV-18, T-PROV-24
**成果物**
- `apps/provisioner/src/orchestrator.ts`
- `apps/provisioner/test/standard-branch.spec.ts`
- `infra/tests/runtime-mutation-scope.sh`

**実装方針**
- STANDARD 分岐で行うのは、Registration の作成、Agent OP への XAA 静的設定の注入（Registration の書き込みで兼ねる）、IdP Connection 作成依頼、Bridge Agent Binding 作成（Bridge 有効時のみ）、共有 Job `agent-runtime-standard` への Execution 起動の5つに限る。
- STANDARD の Execution は常に `sa-agent-runtime` で動かす。Provisioner が Service Account を作る呼び出しを置かない。
- テストダブルとして GCP Admin API クライアントのモックを注入し、STANDARD 経路での呼び出し回数が0であることを assert する。
- STANDARD 分岐から到達可能な GCP クライアントは Firestore と Pub/Sub と Cloud Run Jobs の `JobsClient` の3つに限る。
- Cloud Run Service と Service Account と KMS 鍵を作るのは FULL_ISOLATION 分岐（T-PROV-24）だけであり、STANDARD 分岐からそのモジュールを import しない。
- Agent の識別は Execution へ渡した Agent Client Credential と、その鍵で署名した `actor_token` だけで行う。Execution ごとに SA を分ける分岐を書かない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/standard-branch.spec.ts` が緑になり、GCP Admin API モックの呼び出し回数が0であることを assert している
- [ ] STANDARD の E2E 実行後に `terraform plan` が差分0を返す
- [ ] STANDARD Agent を10体 Provisioning しても `gcloud iam service-accounts list` の件数が変わらないことを検証手順として `e2e` に記録する
- [ ] `grep -rn "createServiceAccount\|createService(" apps/provisioner/src` の結果が `dedicated.ts` の行だけである
- [ ] `grep -rn "dedicated" apps/provisioner/src/orchestrator.ts` の結果が `isolation_level === 'full_isolation'` の分岐の中だけに現れる

---

### T-PROV-28 Provisioning の11段順序とロールバックを実装する

**概要**
docs 07 §3.3 の順序を固定し、Human IdP Connection を先に作る（RULE-51）。
Connection が READY でない状態で外部 Consent 以降へ進む経路を作らない。
途中で失敗したら逆順に補償処理を行う（RULE-27）。

**対象要件** REQ-07-009, REQ-05-063
**前提タスク** T-PROV-17, T-PROV-22, T-PROV-23, T-PROV-24, T-PROV-27
**成果物**
- `apps/provisioner/src/orchestrator.ts`
- `apps/provisioner/src/orchestrator-steps.ts`
- `apps/provisioner/test/order.spec.ts`

**実装方針**
- ステップを配列 `PROVISIONING_STEPS` として宣言し、`create_transaction` / `resolve_tools` / `generate_agent_identity` / `set_expires_at` / `idp_consent` / `verify_idp_connection` / `external_consent` / `create_agent_binding` / `register_agent` / `start_job_execution` / `activate` の11段を順に並べる。
- 各ステップは `{ id, run, compensate }` の3プロパティを持つ。`compensate` が不要なステップは明示的に `noop` を置き、省略しない。
- 現在位置は Transaction の `pending_step` に保存し、Resume はそこから再開する。
- `verify_idp_connection` が `READY` を返すまで `external_consent` 以降のステップを実行しない。順序違反の呼び出しは 409 と `{ error: "precondition_failed", expected_step, actual_step }` を返す。
- 失敗時は、実行済みステップの `compensate` を逆順で呼ぶ。`register_agent` の補償は Registration 削除、`create_agent_binding` の補償は Binding 無効化、`idp_consent` の補償は Connection の revoke 依頼、`create_dedicated_resources` の補償は `destroyDedicatedResources`。
- FULL_ISOLATION の同時数チェックは `generate_agent_identity` の前、Transaction 作成の前に行う（T-PROV-25 の順序）。Dedicated OP 一式の作成はその後に行い、補償配列には削除を最後に走らせる要素として先頭に置く。
- 補償処理自体が失敗しても残りの補償を続行し、失敗の一覧を構造化ログへ出す。例外で中断しない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/order.spec.ts` が緑になり、正常系のステップ実行ログが上記11段と順序まで一致することを assert している
- [ ] IdP Connection が未 READY の状態で `create_agent_binding` へ到達できず 409 `precondition_failed` になるテストが通る
- [ ] `register_agent` で意図的に失敗させると、Binding が無効化され Connection が REVOKED になり、実行時に作った GCP リソースが1つも残らないことを assert する統合テストが緑になる
- [ ] 補償の1つを失敗させても残りの補償が実行され、失敗一覧がログに出るテストが通る

---

### T-PROV-29 Cloud Run Job Execution を1 Agent につき1つ起動する

**概要**
Agent は常駐 Service ではなく Job Execution として動く（RULE-04）。
起動時の env オーバーライドで Agent 固有の値を渡し、Job 定義側にはそれらのキーを持たせない。

**対象要件** REQ-05-060, REQ-07-015, REQ-08-052
**前提タスク** T-PROV-22, T-PROV-06, T-PROV-24
**成果物**
- `apps/provisioner/src/job/execute.ts`
- `apps/provisioner/test/job-exec.spec.ts`

**実装方針**
- 起動は `@google-cloud/run` の `JobsClient.runJob` を使い、`overrides.containerOverrides[0].env` に env を積む。
- 渡す env は `AGENT_ID` / `AGENT_CLIENT_ID` / `AGENT_CLIENT_PRIVATE_JWK` / `AGENT_EXPIRES_AT` / `OP_TOKEN_ENDPOINT` / `AGENT_OP_BASE_URL` / `XAA_CONFIG_JSON` / `TOOL_MANIFEST_JSON` の8件に固定する。要件に現れた `AGENT_CLIENT_PRIVATE_KEY` と `AGENT_SIGNING_JWK` と `EXPIRES_AT` は別名として採用しない。
- `AGENT_CLIENT_ID` は `agent-platform` を入れる。Agent ごとの client_id を作らない（RULE-50）。
- 起動先の Job 名は、STANDARD が `agent-runtime-standard`、FULL_ISOLATION が `agent-runtime-<short>`。名前は `platform_endpoints` から引き、文字列連結で組み立てない。
- 起動前に同一 `agent_id` の Execution が RUNNING でないことを Firestore の `agents/{agent_id}.execution_name` の有無で確認し、存在すれば 409 と `{ error: "execution_already_running" }` を返す。
- Job 定義の `task_count=1` / `parallelism=1` / `max_retries=0` / `task_timeout` は Terraform 側で設定する。Provisioner から `overrides` でこれらを変更しない。
- 起動応答の Execution 名を Registration の `status` 遷移ではなく、Transaction の `pending_step` の完了記録として保持する。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/job-exec.spec.ts` が緑になり、同一 `agent_id` の2重起動が 409 `execution_already_running` になることを assert している
- [ ] `runJob` に渡した `containerOverrides[0].env` のキー集合が上記8件と完全一致するテストが通る
- [ ] `terraform show` で Job 定義が `max_retries=0` かつ `task_count=1` かつ `parallelism=1` であることを `infra/tests` から検査できる
- [ ] Agent を3体作ると Execution が3つ起動し、各 Execution の `AGENT_ID` が相異なることを assert する e2e テストが緑になる
- [ ] `gcloud run jobs describe agent-runtime-standard` の env に `AGENT_ID` が現れないことを検証手順として `e2e` に記録する

---

### T-PROV-30 クライアント登録を作らないことを固定する

**概要**
`client_id` は `agent-platform` の1つに固定する（RULE-50、DEC-ID-22）。
Agent の生成と破棄で Human IdP と Resource AS へクライアント登録を行わない。
Dynamic Client Registration を呼ばない。

**対象要件** REQ-05-080, REQ-10-006
**前提タスク** T-PROV-29
**成果物**
- `scripts/check-no-dcr.sh`
- `e2e/test/single-client.spec.ts`
- `packages/xaa-contracts/src/client-ids.ts`

**実装方針**
- `client-ids.ts` に `PLATFORM_CLIENT_ID = "agent-platform"` を定数として置き、Provisioner はこの定数だけを使う。
- `scripts/check-no-dcr.sh` は `apps/provisioner/src` に対し、`/register` を含む URL 文字列、`registration_endpoint` の参照、`client_secret` の生成が0件であることを検査する。
- Agent 個体の識別は `cnf.jkt` と `act` と Security Detection のログの3つとする。`client_id` に Agent ID を混ぜる分岐を作らない。
- Provisioner から Human IdP と Resource AS への書き込み系の呼び出しを一切作らない。呼ぶのは Agent OP と Bridge の内部 API だけとする。

**完了条件**
- [ ] `bash scripts/check-no-dcr.sh` が終了コード0で通る
- [ ] `e2e/test/single-client.spec.ts` で3体の Agent を Provisioning した後、Human IdP と2つの Resource AS のクライアント登録件数が変わらないことを assert する
- [ ] 同テストで発行された3枚の ID-JAG の `client_id` がすべて `agent-platform` であり、`act.sub` が3種類あることを assert する
- [ ] `grep -rn "agent-platform" apps/provisioner/src` の結果が `client-ids.ts` の import 経由のみである

---

### T-PROV-31 Provisioning の構造化ログを出力する

**概要**
docs 09 §2 が求める Provisioning のログ項目を出す。
実行時作成にしたため `dedicated_short_id` を必須項目に加える（DEC-IAC-07）。
Raw Token と秘密鍵をログへ出さない（RULE-38）。

**対象要件** REQ-09-007
**前提タスク** T-PROV-28, T-PROV-29
**成果物**
- `apps/provisioner/src/logging/provisioning-log.ts`
- `apps/provisioner/test/provisioning-log.spec.ts`
- `e2e/test/provision-log.spec.ts`

**実装方針**
- 1回の Provisioning の完了時に `event: "provisioning_completed"` の1行を Cloud Logging へ JSON で出す。
- 必須フィールドは `agent_id` / `human_subject` / `transaction_id` / `isolation_level` / `dedicated_op` / `dedicated_short_id` / `provisioned_tools` / `allowed_audiences` / `resources` / `scopes` / `idp_connection_status` / `connector_states` / `created_at` / `expires_at` の14件。
- `dedicated_op` は boolean、`dedicated_short_id` は FULL_ISOLATION のとき `<short>`（`agent_id` の乱数部の末尾12文字）、STANDARD のとき null。
- `destroyed_at` は Lifecycle 側の Cleanup ログが持つ。ここでは出さない。
- 出力前に、値が3つのドット区切りの base64url 文字列に一致する要素を再帰的に探し、見つかったら `log_contains_token` を投げてログを出さない。
- ログのシンクは Terraform の Log Sink で BigQuery の `security_audit` dataset へ入る。アプリ側で BigQuery へ直接書かない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/provisioning-log.spec.ts` が緑になり、14フィールドがすべて存在することを assert している
- [ ] JWT 形式の文字列を含む値を渡すと `log_contains_token` が投げられログが出ないテストが通る
- [ ] `e2e/test/provision-log.spec.ts` で STANDARD と FULL_ISOLATION を各1回実行し、FULL_ISOLATION 側のログの `dedicated_short_id` が非 null であることを assert する
- [ ] STANDARD 側のログの `dedicated_short_id` が null かつ `dedicated_op` が false であることを assert する

---

### T-PROV-32 Provisioning の Activity Event を発行する

**概要**
Activity Event は Security Detection の詳細ログとは別系統の Pub/Sub トピックへ流す（RULE-55）。
逐次配信せず、一連をまとめて再生できるよう `sequence` と `phase` を付ける（RULE-59）。
Provisioning Transaction の完了時に終端イベントを1件だけ発行する。

**対象要件** REQ-07-038, REQ-11-016
**前提タスク** T-PROV-28
**成果物**
- `apps/provisioner/src/events/activity.ts`
- `packages/xaa-contracts/src/schemas/activity-event.schema.json`
- `apps/provisioner/test/activity-events.spec.ts`
- `e2e/test/events-provisioner.spec.ts`

**実装方針**
- 発行先は Pub/Sub トピック `agent-activity-stream`。`PUBSUB_MODE=inproc` のときは同一プロセス内のバスへ流す（DEC-APP-09）。
- イベント種別は `provisioning.started` / `provisioning.idp_consent_required` / `provisioning.idp_connection_created` / `provisioning.external_consent_required` / `provisioning.binding_created` / `provisioning.agent_registered` / `provisioning.job_started` / `agent.active` / `agent.expired` / `agent.revoked` / `agent.destroyed` の11種を定数配列で持つ。
- 表示用の `activity_kind` を別フィールドで持ち、`provisioning.idp_consent_required` を `IDP_CONSENT_REQUIRED`、`provisioning.external_consent_required` を `CONSENT_REQUIRED`、`agent.active` を `AGENT_PROVISIONED` に写像する。他の9種は `PROVISIONING_STEP` とする。
- 共通フィールドは `event_type` / `activity_kind` / `phase` / `outcome` / `sequence` / `human_subject` / `agent_id` / `transaction_id` / `task_id` / `message` / `occurred_at`。
- `phase` は Provisioning のイベントすべてで `provisioning`、`task_id` は `provisioning` とする。
- `outcome` は `provisioning.external_consent_required` と `provisioning.idp_consent_required` が `info`、`agent.active` が `success`、失敗時の終端が `blocked`。
- `sequence` は Transaction ごとの1始まり連番とし、Transaction ドキュメントの `sequence` フィールドを `runTransaction` で加算して採番する。
- `message` は発行元が日本語で埋める。`CONSENT_REQUIRED` には Connector 名、`AGENT_PROVISIONED` には `expires_at` を含める。
- 発行前に、ペイロード全体を再帰走査して3つのドット区切りの base64url 文字列が無いことを検査する。
- `agent.active` は Transaction が `COMPLETED` へ遷移する箇所1か所からのみ発行する。失敗した Provisioning では発行しない。

**完了条件**
- [ ] `pnpm vitest run apps/provisioner/test/activity-events.spec.ts` が緑になり、1回の Provisioning から11種のイベントが `sequence` 昇順で発行されることを assert している
- [ ] いずれのペイロードにも JWT 形式の文字列が含まれないことを assert するテストが通る
- [ ] `e2e/test/events-provisioner.spec.ts` で外部 Consent を伴う Provisioning から `activity_kind: "CONSENT_REQUIRED"` が1件、`AGENT_PROVISIONED` が1件だけ出ることを assert する
- [ ] 失敗した Provisioning で `AGENT_PROVISIONED` が0件になることを assert するテストが通る
