# 12. OAuth Bridge（Google Bridge）（T-BRIDGE）

OAuth Bridge は、ID-JAG を理解しない外部 OAuth SaaS を XAA モデルへ接続する互換レイヤーである。
Agent Runtime が持ってきた ID-JAG を検証し、あらかじめ人間ユーザーの Consent で得た SaaS の Refresh Token を使って短命な SaaS Access Token を払い出す。
SaaS の業務 API そのものは Bridge が呼ばず、払い出した Access Token を使って Agent Runtime が直接呼ぶ。
本領域は Agent 向けの internal API 面と、ブラウザから到達する OAuth Callback 面の2面を作り、Connection（人間ごと）と Agent Binding（Agent ごと）の2層データを持つ。
DEC-SCOPE-04 により、この領域が作るものはすべて Terraform 変数 `enable_google_bridge=true` のときだけデプロイされ、既定 apply では1つも作られない。

| 前提 | 内容 |
|---|---|
| 依存する領域 | Agent OP（ID-JAG 発行）、Agent Runtime / Tool Executor（ID-JAG 提示）、Provisioner（Consent 開始と Binding 作成）、Lifecycle Manager（Binding の無効化と削除）、Security Detection（Protocol Validation イベント）、Infra（Cloud Run と KMS と Secret Manager の定義） |
| このファイルのタスク数 | 20件 |
| 主に満たす設計ルール | RULE-21, RULE-22, RULE-23, RULE-24, RULE-36, RULE-38, RULE-45 |

要件文が Cloud SQL の `connector` DB を前提にしている箇所（REQ-06-010、REQ-06-011、REQ-06-023 の DB User 権限）は、DEC-IAC-09 に従い Firestore(Native mode) のコレクションとアプリ側パスガードへ読み替える。
読み替えの対応は T-BRIDGE-04 に書き、他のタスクではその結果だけを使う。

---

### T-BRIDGE-01 Bridge アプリの骨格を作り、2面分割とルート集合を固定する

**概要**
`enable_google_bridge=true` のときのみ動く Bridge アプリの骨格を作る。
1つのコードベースを internal 面と callback 面の2つの Cloud Run Service としてデプロイするため、面ごとにマウントするルートを切り替える形にする。
docs 06 §2 の「担当しない」を構成で強制するため、ルート集合と依存パッケージをこの時点で固定する。

**対象要件** REQ-06-023
**前提タスク** なし
**成果物** `apps/google-bridge/package.json`, `apps/google-bridge/tsconfig.json`, `apps/google-bridge/src/index.ts`, `apps/google-bridge/src/app-internal.ts`, `apps/google-bridge/src/app-callback.ts`, `apps/google-bridge/src/routes/healthz.ts`, `apps/google-bridge/src/config.ts`, `apps/google-bridge/src/errors.ts`, `apps/google-bridge/test/routes-snapshot.spec.ts`, `apps/google-bridge/test/dependencies.spec.ts`

**実装方針**
- `src/index.ts` は `createApp(): Hono` を default export する（DEC-APP-07）。
- `createApp()` は環境変数 `BRIDGE_FACE`（`internal` | `callback`、既定なし、未設定は起動時に例外）で分岐し、`createInternalApp()` または `createCallbackApp()` を返す。両者は named export としても公開し、integration ハーネスが1プロセス内で両方を起動できるようにする。
- internal 面のルートは `POST /token`、`POST /connections/check`、`POST /connections/verify`、`POST /bindings`、`POST /bindings/:agent_id/disable`、`DELETE /bindings/:agent_id`、`GET /livez` の7本に固定する。
- callback 面のルートは `GET /:connector_id/oauth/start`、`GET /:connector_id/oauth/callback`、`GET /livez` の3本に固定する。
- `test/routes-snapshot.spec.ts` は `app.routes` を method と path のソート済み配列へ落として文字列スナップショットと比較する。スナップショットは `apps/google-bridge/test/__snapshots__/routes.snap` にコミットする。
- `test/dependencies.spec.ts` は `package.json` の `dependencies` キー集合が許可リスト `hono`, `@hono/node-server`, `ajv`, `ajv-formats`, `@google-cloud/firestore`, `@google-cloud/kms`, `@google-cloud/secret-manager`, `@maronn-openid-connect/experimental`, `@xaa/contracts`, `@xaa/crypto`, `@xaa/gcp` と完全一致することを検査する。
- Vertex AI SDK、LLM クライアント、HTTP プロキシ用ライブラリを依存に入れない。Gmail / Calendar / ドキュメント API を中継するルートを追加しない。
- `src/config.ts` は環境変数を1か所で読む。読む変数は `BRIDGE_FACE`, `BRIDGE_INTERNAL_BASE_URL`, `BRIDGE_CALLBACK_BASE_URL`, `AUTOMATION_APP_BASE_URL`, `PROVISIONER_BASE_URL`, `SHARED_ISSUER`, `JWKS_URL`, `CONNECTOR_ENCRYPTION_KEY`, `AGENT_MAX_LIFETIME_SECONDS`, `SAAS_CONNECTOR_MODE`, `STORE_MODE`, `CALLER_SA_RUNTIME`, `CALLER_SA_SLOTS`, `CALLER_SA_PROVISIONER`, `CALLER_SA_LIFECYCLE` に限る。未設定の必須変数は起動時に例外を投げ、既定値で代替しない。
- `src/errors.ts` に Bridge のエラーコードを union 型 `BridgeErrorCode` として定義する。値は `forbidden_caller`, `unsupported_grant_type`, `invalid_grant`, `invalid_scope`, `invalid_target`, `invalid_dpop_proof`, `connection_revoked`, `code_already_used`, `scope_not_in_connection`, `human_subject_mismatch`, `expires_at_too_far`, `binding_already_exists` の12個に固定する。

**完了条件**
- [x] `pnpm --filter google-bridge test -t "routes snapshot"` が green で、スナップショットに internal 8本（00b §4 が internal 8ルート目とする `POST /connections/{connection_id}/revoke-upstream` を含む）と callback 3本以外の経路が現れない。
- [x] `pnpm --filter google-bridge test -t "dependencies allowlist"` が green で、`package.json` に `@google-cloud/vertexai` を追記すると red になる。（実体は `apps/google-bridge/test/dependencies.spec.ts`）
- [x] `BRIDGE_FACE` を未設定にして `createApp()` を呼ぶと例外が投げられることを単体テストで確認できる。（実体は `apps/google-bridge/test/dependencies.spec.ts`）
- [x] `pnpm --filter google-bridge build` が tsc で成功し、`dist/index.js` が生成される。

---

### T-BRIDGE-02 経路ごとの呼び出し元 Service Account 認可ミドルウェアを実装する

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。
Cloud Run IAM はサービス単位でしか絞れないため、internal 面の6ルートを経路ごとに呼び出し元 SA で絞る（RULE-36）。
Authorization ヘッダの Google 発行 ID トークンを検証し、`email` クレームを経路ごとの許可リストと突き合わせる。

**対象要件** REQ-06-002
**前提タスク** T-BRIDGE-01
**成果物** `apps/google-bridge/src/middleware/caller-authz.ts`, `apps/google-bridge/src/middleware/google-id-token.ts`, `apps/google-bridge/test/caller-authz.test.ts`

**実装方針**
- `verifyGoogleIdToken(token, audience)` を `src/middleware/google-id-token.ts` に実装する。検証順序は 署名（`https://www.googleapis.com/oauth2/v3/certs` の JWKS、TTL 3600 秒でキャッシュ）→ `iss === "https://accounts.google.com"` → `aud === config.bridgeInternalBaseUrl` → `exp` → `email_verified === true` に固定する。
- `callerAuthz(allowed: CallerRole[])` を Hono ミドルウェアとして実装する。`CallerRole` は `runtime` | `provisioner` | `lifecycle` の3値。
- 許可リストは `config` から作る。`runtime` は `CALLER_SA_RUNTIME` と `CALLER_SA_SLOTS`（カンマ区切りの `sa-agent-aaaaaaaaaaaa@...` 形式）の和集合、`provisioner` は `CALLER_SA_PROVISIONER`、`lifecycle` は `CALLER_SA_LIFECYCLE`。突き合わせは文字列の完全一致で行い、接尾辞一致や正規表現を使わない。
- ルートへの適用は `POST /token` が `["runtime"]`、`POST /connections/check` と `POST /connections/verify` と `POST /bindings` が `["provisioner"]`、`POST /bindings/:agent_id/disable` と `DELETE /bindings/:agent_id` が `["lifecycle"]`。
- 許可外は HTTP 403 と `{"error":"forbidden_caller"}` を返し、拒否理由に SA の email を含めない。同時に `emitProtocolValidation("forbidden_bridge_caller", {route, caller_email})` を呼ぶ（T-SEC-11 が配線する共通ヘルパを使う）。
- ID トークンが無い、壊れている、`aud` が違う場合も同じ 403 `forbidden_caller` に寄せ、401 と 403 を使い分けない。
- callback 面にはこのミドルウェアを適用しない。

**完了条件**
- [x] `apps/google-bridge/test/caller-authz.test.ts` の `runtime SA calls /bindings -> 403` / `provisioner SA calls /bindings -> 201` / `provisioner SA calls /token -> 403` / `lifecycle SA calls /bindings/:id/disable -> 204` の4ケースが green。（実体は `apps/google-bridge/test/caller-authz.spec.ts`）
- [x] Authorization ヘッダ無しの `/token` が 403 と `forbidden_caller` を返すテストが green。（実体は `apps/google-bridge/test/caller-authz.spec.ts`）
- [x] `aud` を別サービスの URL にした ID トークンが 403 になるテストが green。（実体は `apps/google-bridge/test/caller-authz.spec.ts`）
- [x] 403 応答の本文に `email` を含む文字列が現れないことをテストで確認できる。（実体は `apps/google-bridge/test/caller-authz.spec.ts`）

---

### T-BRIDGE-03 Connector Definition レジストリを設定駆動で実装する

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。
docs 06 §1 の「Microsoft、GitHub など他の OAuth SaaS も同じパターンで追加する」を、コード変更なしの追加で満たす。
Bridge のコードに `google` を直書きせず、`connector_id` をキーに Firestore から Connector Definition を読む。

**対象要件** REQ-06-021
**前提タスク** T-BRIDGE-01
**成果物** `apps/google-bridge/src/connectors/types.ts`, `apps/google-bridge/src/connectors/registry.ts`, `apps/google-bridge/schemas/connector-definition.schema.json`, `apps/google-bridge/test/connector-registry.test.ts`

**実装方針**
- Firestore コレクション `connector_definitions/{connector_id}` を読み取り専用で参照する。書き込み関数を実装しない。
- ドキュメントの項目は `connector_id`, `display_name`, `authorization_endpoint`, `token_endpoint`, `revocation_endpoint`, `userinfo_endpoint`, `client_id`, `secret_name`, `default_scopes`（string 配列）, `subject_claim`, `connection_max_age_seconds`, `resource_uris`（string 配列）。
- `resource_uris` は ID-JAG の `resource` クレームから connector を逆引きするために置く。docs 06 §1 の列挙には無いが、`/token` のパスに connector_id を含めない以上、逆引きの根拠が他に無いため必須項目とする。
- 検証は `schemas/connector-definition.schema.json` を Ajv（strict、`additionalProperties:false`）で行い、4つの endpoint が `https:` で始まる絶対 URI であることと `resource_uris` が1件以上あることを必須にする。検証に落ちた行は使わず、`invalid_target` として扱う。
- `getConnector(connectorId): Promise<ConnectorDefinition>` と `findConnectorByResource(resource): Promise<ConnectorDefinition>` の2関数を export する。後者は `resource_uris` の要素との完全一致で引き、前方一致や部分一致を使わない。一致0件と2件以上はどちらも `invalid_target`。
- キャッシュは connector_id をキーに TTL 60 秒のインメモリキャッシュとし、更新の反映を待たずに済ませる分岐を持たない。
- `client_secret` は定義に持たせない。`secret_name` から Secret Manager を都度読む（T-BRIDGE-09）。
- 検証環境では `saas_connector_mode=stub` のとき `stub-saas` の1件だけを seed する。`google` のとき `google-workspace` を seed する。seed 投入そのものは Bridge のコードに書かない。

**完了条件**
- [~] `apps/google-bridge/test/connector-registry.test.ts` の `second connector works without redeploy` が green。Firestore エミュレータへ `connector_definitions/second` を INSERT するだけで `GET /second/oauth/start` が 302 を返す。（デプロイ後に `scripts/deploy-gcp-guide.sh` の verify 段が観測する）
- [x] `grep -rn "google" apps/google-bridge/src --include=*.ts | grep -v "googleapis.com" | grep -v "google-id-token" | grep -v "google-bridge" | grep -v "google_bridge" | grep -v "@google-cloud/"` の出力が0行。
- [x] `resource_uris` を2件の Connector で重複させたとき `findConnectorByResource` が `invalid_target` を投げるテストが green。（実体は `apps/google-bridge/test/bridge.spec.ts`）
- [x] `authorization_endpoint` を `http:` にした定義が Ajv 検証で拒否されるテストが green。（実体は `apps/google-bridge/test/bridge.spec.ts`）

---

### T-BRIDGE-04 Connection と Agent Binding のスキーマと暗号文型を実装する

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。
要件が指定する Cloud SQL の `connection` / `agent_binding` テーブルを、DEC-IAC-09 に従って Firestore のコレクションへ読み替えて実装する。
一意制約は決定的なドキュメント ID で置き換え、Refresh Token の平文が列にもログにも入らないことを型で防ぐ。

**対象要件** REQ-06-010, REQ-06-011
**前提タスク** T-BRIDGE-01
**成果物** `apps/google-bridge/src/store/connection.ts`, `apps/google-bridge/src/store/binding.ts`, `apps/google-bridge/src/store/ciphertext.ts`, `apps/google-bridge/schemas/connection.schema.json`, `apps/google-bridge/schemas/agent-binding.schema.json`, `apps/google-bridge/test/store-schema.spec.ts`, `packages/gcp/src/firestore-guard.ts`（Bridge の許可パス追記）

**実装方針**
- `bridge_connections/{connection_id}` の項目は `connection_id`, `connector_id`, `human_subject`, `external_subject`, `encrypted_refresh_token`（Firestore の Bytes）, `granted_scopes`（string 配列）, `status`（`ACTIVE` | `EXPIRED` | `REVOKED`）, `created_at`, `expires_at`。
- `connection_id` は `${connector_id}:${sha256(human_subject) の先頭32桁}` で決定的に組み立てる。これが `(connector_id, human_subject)` の一意制約の代わりになる。ランダム ID を使わない。
- `agent_bindings/{binding_id}` の項目は `binding_id`, `agent_id`, `connector_id`, `connection_id`, `human_subject`, `scopes`（string 配列）, `status`（`ACTIVE` | `DISABLED`）, `created_at`, `expires_at`。
- `binding_id` は `${agent_id}:${connector_id}` とする。これが `(agent_id, connector_id)` の一意制約の代わりになる。作成は `create()` を使い、既存があれば Firestore の ALREADY_EXISTS を `binding_already_exists` へ変換する。`set()` の上書きを使わない。
- `src/store/ciphertext.ts` に `type Ciphertext = Uint8Array & { readonly __brand: "kms-ciphertext" }` を定義し、`toCiphertext(bytes: Uint8Array)` を KMS 呼び出し結果だけが通る内部関数として置く。`saveEncryptedRefreshToken(connectionId, value: Ciphertext)` は `Ciphertext` 以外を受け付けず、`string` を渡すとコンパイルエラーになる。
- `granted_scopes` と `scopes` は保存時に重複を除去して昇順ソートする。空白区切りの1文字列として保存しない。
- `packages/gcp/src/firestore-guard.ts` の許可マトリクスに、Bridge の許可パスとして `bridge_connections/**`（読み書き）、`agent_bindings/**`（読み書き）、`connector_definitions/**`（読みのみ）、`bridge_consent_states/**`（読み書き）、`bridge_consent_codes/**`（読み書き）、`bridge_dpop_jti/**`（読み書き）を追加する。`agent_definitions/**` と `authorizations/**` は追加しない（REQ-06-023）。
- Firestore の TTL 用に `bridge_consent_states` / `bridge_consent_codes` / `bridge_dpop_jti` には `expire_at` フィールドを必ず入れる。
- Connection の行を Agent 破棄で削除する経路を実装しない。

**完了条件**
- [x] `apps/google-bridge/test/store-schema.spec.ts` で、同じ `(connector_id, human_subject)` の Connection を2回作ると同じ `connection_id` になり行が1件のままであることを確認できる。
- [x] 同じ `(agent_id, connector_id)` の Binding を2回作ると2回目が `binding_already_exists` になるテストが green。（実体は `apps/google-bridge/test/bindings-api.spec.ts`）
- [x] `saveEncryptedRefreshToken(id, "plain-text")` を含むテストファイルを追加すると `pnpm --filter google-bridge typecheck` が非ゼロ終了する。
- [x] `packages/gcp/test/firestore-guard.spec.ts` に「Bridge から `agent_definitions/x` の読み取りが拒否される」ケースを追加し green。

---

### T-BRIDGE-05 /token の ID-JAG 検証を maronn の redeem 関数で実装する

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。
`/token` が受ける ID-JAG を、`parseIdJagRedemptionParams` と `verifyIdJagAssertion` で検証する（RULE-45）。
JWKS は Cloud Storage の `jwks.json` を起動時に取得して TTL 付きでキャッシュし、assertion 内の値から鍵取得先を導出しない。

**対象要件** REQ-06-003
**前提タスク** T-BRIDGE-01, T-BRIDGE-02
**成果物** `apps/google-bridge/src/routes/token.ts`, `apps/google-bridge/src/idjag/verify.ts`, `apps/google-bridge/src/idjag/jwks-cache.ts`, `apps/google-bridge/test/id-jag-redeem.test.ts`

**実装方針**
- `grant_type` は `@xaa/contracts` の `JWT_BEARER_GRANT_TYPE`（`urn:ietf:params:oauth:grant-type:jwt-bearer`、experimental からの再輸出）とバイト一致で比較する。文字列リテラルを `token.ts` に直書きしない。
- `urn:ietf:params:oauth:grant-type:jwt-dpop` を含むそれ以外の値は HTTP 400 と `{"error":"unsupported_grant_type"}` を返す。
- パラメータ解析は `@maronn-openid-connect/experimental/id-jag` の `parseIdJagRedemptionParams` を使う。自前で `assertion` を切り出さない。
- 署名検証は同パッケージの `verifyIdJagAssertion` を使い、`trustedIdentityProviders` に `{ issuer: config.sharedIssuer, jwks }` の1件だけを渡す。`options.issuer` には `config.bridgeInternalBaseUrl`（= ID-JAG の `aud`、DEC-ID-05）を渡す。
- `jwks-cache.ts` は `config.jwksUrl` を fetch し、TTL 300 秒でキャッシュする。取得失敗時は直前のキャッシュを使い、キャッシュも無ければ 503 を返す。assertion の `jku` / `x5u` / `jwk` ヘッダを読むコードを書かない。
- `verifyIdJagAssertion` の後に `client_id === "agent-platform"` を確認する。一致しなければ `invalid_grant`。
- 署名検証の直後に JOSE ヘッダの `typ === "oauth-id-jag+jwt"` を検査する（DEC-ID-18）。ライブラリ側で検査されている場合も自前の検査を残し、二重に確認する。
- 検証結果は `VerifiedIdJag { sub, actSub, aud, scope, resource, exp, cnfJkt, kid, issuer }` へ正規化して後続ステップへ渡す。`cnf` は payload の再デコードで取り出す（`verifyIdJagAssertion` の戻り値には載らない）。
- 検証失敗の理由をエラー本文に書き分けない。すべて `invalid_grant` に寄せ、詳細は構造化ログにだけ出す。

**完了条件**
- [x] `apps/google-bridge/test/id-jag-redeem.test.ts` の `valid ID-JAG -> 200` / `typ != oauth-id-jag+jwt -> invalid_grant` / `unknown issuer -> invalid_grant` / `grant_type=...jwt-dpop -> unsupported_grant_type` の4ケースが green。（実体は `apps/google-bridge/test/id-jag-redeem.spec.ts`）
- [x] `aud` を別サービスの URL にした ID-JAG が `invalid_grant` になるテストが green。（実体は `apps/google-bridge/test/id-jag-redeem.spec.ts`）
- [x] `grep -rn "jku\|x5u" apps/google-bridge/src` の出力が1行で、それが `src/idjag/verify.ts` の禁止ヘッダ一覧（`jku` / `x5u` / `jwk` を持つ assertion を拒否する行）であり、鍵取得先として読む箇所が無い。
- [x] JWKS の HTTP 取得を1回だけ行い、TTL 内の2回目の `/token` で再取得が発生しないことをモックの呼び出し回数で確認できる。（実体は `apps/google-bridge/test/id-jag-redeem.spec.ts`）

---

### T-BRIDGE-06 cnf.jkt と DPoP Proof の照合を fail-closed で実装する

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。
maronn の redeem 系は `cnf` を扱わないため、ID-JAG 検証の後にアプリ層で Proof of Possession を足す（RULE-44、DEV-11 と同じ方針）。
ID-JAG に `cnf.jkt` があるとき DPoP Proof を必須とし、鍵の一致まで確認する。

**対象要件** REQ-06-004
**前提タスク** T-BRIDGE-05
**成果物** `apps/google-bridge/src/dpop/cnf-binding.ts`, `apps/google-bridge/src/dpop/jti-store.ts`, `apps/google-bridge/test/cnf-dpop.test.ts`

**実装方針**
- 検証関数は `verifyCnfBinding(req, verified: VerifiedIdJag): Promise<void>` の1本にする。呼び出し位置は T-BRIDGE-05 の ID-JAG 検証の直後、Binding 解決（T-BRIDGE-07）の直前に固定する。
- `cnf.jkt` が無い ID-JAG は `invalid_grant` を返す。cnf 無しを許容する分岐を実装しない（DEC-ID-08 と対称）。
- `DPoP` ヘッダが無ければ `invalid_grant`。ヘッダはあるが検証に落ちた場合は `invalid_dpop_proof`。この使い分けを要件どおりに保つ。
- Proof 検証は `@xaa/crypto` の `verifyDpopProof({ proof, htm, htu, jtiStore, now })` を使い、自前で JWS を展開しない。検証順序は 署名 → `typ === "dpop+jwt"` → `htm === "POST"` → `htu === \`${config.bridgeInternalBaseUrl}/token\`` → `iat` が ±60 秒 → `jti` 未使用 に固定する。
- `/token` は Access Token を伴わないため `ath` は期待しない。Proof に `ath` クレームが存在する場合は `invalid_dpop_proof` として拒否する。
- Thumbprint 照合は `@xaa/crypto` の `jwkThumbprint(header.jwk)`（RFC 7638）の戻り値と `verified.cnfJkt` をバイト一致で比較する。base64url 文字列を正規化して比較する処理を挟まない。
- `jti-store.ts` は Firestore `bridge_dpop_jti/{jti}` への `create()` を使い、ALREADY_EXISTS を重複として扱う。`expire_at` を `now + 60 秒` で入れる。インメモリ Map だけの実装にしない（Cloud Run の複数インスタンスで漏れるため）。
- 失敗時は `emitProtocolValidation("replayed_dpop_proof" | "invalid_dpop_proof", {agent_id, jkt})` を呼ぶ。Proof 文字列そのものをログへ渡さない。

**完了条件**
- [x] `apps/google-bridge/test/cnf-dpop.test.ts` の `no proof -> invalid_grant` / `other key -> invalid_dpop_proof` / `htu mismatch -> invalid_dpop_proof` / `replayed jti -> invalid_dpop_proof` / `valid proof -> 200` の5ケースが green。（実体は `apps/google-bridge/test/cnf-dpop.spec.ts`）
- [x] `ath` を付けた Proof が `invalid_dpop_proof` になるテストが green。（実体は `apps/google-bridge/test/cnf-dpop.spec.ts`）
- [x] `cnf` を持たない ID-JAG が `invalid_grant` になるテストが green。（実体は `apps/google-bridge/test/cnf-dpop.spec.ts`）
- [x] `iat` を 61 秒過去にした Proof が拒否されるテストが green。（実体は `apps/google-bridge/test/cnf-dpop.spec.ts`）

---

### T-BRIDGE-07 Agent Binding の解決と期限判定を実装する

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。
検証済み ID-JAG の `act.sub` と `sub` から Agent Binding と Connection を引き、5条件をすべて満たすときだけ先へ進む（RULE-24、RULE-46）。
期限切れは要求受信時に判定し、`expired_bridge_connection` の Protocol Validation イベントを出して拒否する（RULE-51、RULE-26）。

**対象要件** REQ-06-005, REQ-09-029
**前提タスク** T-BRIDGE-04, T-BRIDGE-06
**成果物** `apps/google-bridge/src/token/resolve-binding.ts`, `apps/google-bridge/test/binding-resolve.test.ts`

**実装方針**
- `resolveBinding(verified: VerifiedIdJag, now: Date)` を実装し、`/token` のハンドラから DPoP 照合の直後に呼ぶ。
- `act.sub` は `urn:xaa:agent:<agent_id>` 形式（DEC-ID-10）。接頭辞を除いた残りを `agent_id` とする。`act` が無い、または接頭辞が違う ID-JAG は `invalid_grant`。
- connector_id は `findConnectorByResource(verified.resource)` で引く（T-BRIDGE-03）。一致しなければ `invalid_target`。
- 判定順序は (a) `agent_bindings/${agent_id}:${connector_id}` が存在する → (b) `status === "ACTIVE"` → (c) `expires_at > now` → (d) `binding.human_subject === verified.sub` → (e) `bridge_connections/${binding.connection_id}` が存在し `status === "ACTIVE"` かつ `expires_at > now` に固定する。
- (a)(b)(d) の失敗は `invalid_grant` を返し、`emitProtocolValidation("invalid_bridge_binding", {...})` を出す。(c) と (e) の期限超過は `invalid_grant` を返し、`emitProtocolValidation("expired_bridge_connection", {agent_id, connection_id, binding_expires_at, connection_expires_at})` を出す。
- 実効期限は `min(binding.expires_at, connection.expires_at, verified.exp)` とし、ID-JAG の `exp` が Agent の `expires_at` で頭打ちになっている前提（DEC-ID-09）をそのまま利用する。Agent の生存時間を Bridge が別途 Firestore から引き直さない。
- どの失敗経路でも SaaS の token endpoint を呼ばない。SaaS 呼び出しは本関数が成功を返した後にだけ行う構造にする。
- 期限切れの Binding を自動で `DISABLED` に更新しない。状態遷移は Lifecycle Manager（T-LIFE-04）に任せる。

**完了条件**
- [x] `apps/google-bridge/test/binding-resolve.test.ts` の `no binding` / `expired binding` / `DISABLED binding` / `connection REVOKED` / `missing act` の5ケースがすべて `invalid_grant` を返す。（実体は `apps/google-bridge/test/bridge.spec.ts`）
- [x] 上記5ケースで SaaS token endpoint モックの呼び出し回数が 0 であることを assert している。（実体は `apps/google-bridge/test/bridge.spec.ts`）
- [x] `expired binding` と `connection expired` の2ケースで `expired_bridge_connection` イベントが1件ずつ記録されるテストが green。（実体は `apps/google-bridge/test/bridge.spec.ts`）
- [x] `binding.human_subject` と ID-JAG の `sub` が食い違うケースが `invalid_grant` になるテストが green。（実体は `apps/google-bridge/test/bridge.spec.ts`）

---

### T-BRIDGE-08 scope の二重包含チェックを集合演算で実装する

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。
実効 scope ⊆ Binding の scopes ⊆ Connection の granted_scopes を確認する（RULE-24、RULE-52）。
同じ包含判定を Binding 作成時にも使い、Connection に無い scope を持つ Binding が生まれないようにする。

**対象要件** REQ-06-006
**前提タスク** T-BRIDGE-07
**成果物** `apps/google-bridge/src/scope/subset.ts`, `apps/google-bridge/src/token/effective-scope.ts`, `apps/google-bridge/test/scope-subset.test.ts`

**実装方針**
- `src/scope/subset.ts` に `parseScope(value: string): Set<string>` と `isSubset(a: Set<string>, b: Set<string>): boolean` を置く。判定は `Set` 同士で行い、空白区切り文字列の `includes` や正規表現を使わない。順序と重複に依存しない。
- 実効 scope は「リクエストの `scope` パラメータがあればその値、無ければ ID-JAG の `scope` クレーム」とし、リクエスト側が ID-JAG の scope の部分集合でなければ `invalid_scope`。縮小のみ許し、拡大を許す分岐を実装しない。
- 続けて 実効 scope ⊆ `binding.scopes`、`binding.scopes` ⊆ `connection.granted_scopes` の2段を確認する。どちらの違反も `invalid_scope`。
- 空集合の実効 scope は `invalid_scope` として拒否する。空を「全部許可」と解釈しない。
- 同じ `isSubset` を T-BRIDGE-18 の Binding 作成検証からも呼ぶ。判定ロジックを2か所に書かない。
- 拒否時は `emitProtocolValidation("bridge_scope_violation", {requested, binding, connection})` を出す。scope 名は秘密ではないためログへ載せてよい。

**完了条件**
- [x] `apps/google-bridge/test/scope-subset.test.ts` で、connection=`[calendar.read, gmail.send]` / binding=`[calendar.read]` のとき `scope=gmail.send` が `invalid_scope`、`scope=calendar.read` が 200 になる。（実体は `apps/google-bridge/test/bridge.spec.ts`）
- [x] scope の順序を入れ替えた要求と重複を含む要求が、どちらも同じ判定結果になるテストが green。（実体は `apps/google-bridge/test/bridge.spec.ts`）
- [x] `scope=""` と `scope` パラメータ省略かつ ID-JAG の scope が空のケースが `invalid_scope` になるテストが green。（実体は `apps/google-bridge/test/bridge.spec.ts`）
- [x] ID-JAG の scope に無い値をリクエストの `scope` で追加した要求が `invalid_scope` になるテストが green。（実体は `apps/google-bridge/test/bridge.spec.ts`）

---

### T-BRIDGE-09 SaaS の Refresh Token Grant を実行し Access Token を取得する

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。
検証をすべて通ったとき、Connection の暗号化済み Refresh Token を KMS で復号し、Connector の token endpoint へ Refresh Token Grant を投げる（RULE-22）。
Rotation で新しい Refresh Token が返った場合の再暗号化と、SaaS が `invalid_grant` を返した場合の失効処理まで含める。

**対象要件** REQ-06-007
**前提タスク** T-BRIDGE-08
**成果物** `apps/google-bridge/src/saas/refresh-grant.ts`, `apps/google-bridge/src/saas/secret.ts`, `apps/google-bridge/src/kms/connector-cipher.ts`, `apps/google-bridge/test/refresh-grant.test.ts`

**実装方針**
- `connector-cipher.ts` に `encryptRefreshToken(plain: string): Promise<Ciphertext>` と `decryptRefreshToken(cipher: Ciphertext): Promise<string>` を置く。鍵は `CONNECTOR_ENCRYPTION_KEY`（DEC-IAC-12 の `connector-encryption` Key Ring の CryptoKey リソース名）。KMS の Encrypt 応答の `ciphertext` をそのまま保存し、別のエンコードを噛ませない。
- `secret.ts` は `secret_name` から Secret Manager の `latest` バージョンを読む。値をモジュールスコープの変数へ保存せず、呼び出しごとに読む。
- POST の本文は `grant_type=refresh_token`、`refresh_token`、`client_id`、`client_secret`、`scope=<実効 scope を空白区切り>` の5項目に固定する。`application/x-www-form-urlencoded` で送る。
- 送信は T-BRIDGE-11 の `bridgeFetch()` 経由に限る。素の `fetch` を呼ばない。
- 応答の 200 では `access_token` / `expires_in` / `scope` のみを取り出す。`id_token` が返っても捨てる。
- 応答に `refresh_token` が含まれる場合は `encryptRefreshToken` で暗号化し、`bridge_connections/{id}` の `encrypted_refresh_token` を単一フィールド更新で上書きする。旧暗号文を別フィールドや別コレクションへ退避しない。
- 応答が 4xx かつ本文の `error === "invalid_grant"` の場合は Connection を `status="REVOKED"` に更新し、Agent へ HTTP 400 と `{"error":"connection_revoked"}` を返す。それ以外の 4xx / 5xx は Connection の status を変えず HTTP 502 と `{"error":"invalid_grant"}` を返す。
- 復号した Refresh Token を格納する変数のスコープを関数内に閉じ、戻り値と例外メッセージとログのいずれにも渡さない。
- 再試行を実装しない。SaaS 側のタイムアウトは 10 秒で打ち切る。

**完了条件**
- [x] `apps/google-bridge/test/refresh-grant.test.ts` で stub SaaS OP に対し `access_token` が返り、`/token` が 200 を返す。（実体は `apps/google-bridge/test/bridge.spec.ts`）
- [x] stub が rotation 応答を返したとき、Firestore の `encrypted_refresh_token` のバイト列が呼び出し前後で変化することを assert できる。（実体は `apps/google-bridge/test/bridge.spec.ts`）
- [x] stub が `{"error":"invalid_grant"}` を返したとき `bridge_connections` の `status` が `REVOKED` になり、応答が `connection_revoked` になるテストが green。（実体は `apps/google-bridge/test/bridge.spec.ts`）
- [x] stub が 500 を返したとき `status` が `ACTIVE` のままで応答が 502 になるテストが green。（実体は `apps/google-bridge/test/bridge.spec.ts`）

---

### T-BRIDGE-10 /token の応答形を固定し外部 SaaS への DPoP 強制を排除する

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。
`/token` の応答 JSON のキー集合を4つに固定し、長期 Credential を Agent へ渡さない（RULE-22、RULE-38）。
あわせて、外部 SaaS 向けに払い出すトークンへ `cnf` を付けず Bearer のままとする方針をコードで固定する（DEC-ID-13）。

**対象要件** REQ-06-009, REQ-05-023
**前提タスク** T-BRIDGE-09
**成果物** `apps/google-bridge/src/token/response.ts`, `apps/google-bridge/schemas/token-response.schema.json`, `apps/google-bridge/test/response-shape.test.ts`, `scripts/check-bridge-no-refresh-token.sh`

**実装方針**
- 応答型を `type BridgeTokenResponse = { access_token: string; token_type: "Bearer"; expires_in: number; scope: string }` に固定する。`token_type` は文字列リテラル型 `"Bearer"` とし、`"DPoP"` を返す分岐を作らない。
- `buildTokenResponse()` は上記4キーだけを持つオブジェクトリテラルを新規に組み立てる。SaaS の応答オブジェクトをスプレッドしない。
- 応答を返す直前に `schemas/token-response.schema.json`（Ajv、`additionalProperties:false`、4キー必須）で自己検証し、落ちたら 500 を返して応答本文を送らない。
- `cnf` を付ける処理を書かない。Bridge が払い出す Access Token は Bearer 提示を前提にし、Agent Runtime に DPoP Proof を要求する分岐も実装しない。
- Consent 時に SaaS から受け取る初回 Access Token は、Callback 処理（T-BRIDGE-15）の関数内ローカル変数に留め、Firestore へ書かず戻り値にも載せない。
- ログは T-BRIDGE-12 のフィールド許可リスト経由に限る。`access_token` / `refresh_token` / `client_secret` / `assertion` の値を引数に取る `console.*` を書かない。
- `scripts/check-bridge-no-refresh-token.sh` は `apps/google-bridge/src/routes/token.ts` と `apps/google-bridge/src/token/` に `refresh_token` の文字列が現れないことを grep で検査し、現れたら非ゼロ終了する。Refresh Token Grant の本文組み立ては `src/saas/refresh-grant.ts` 側にあるため、この検査は成立する。

**完了条件**
- [x] `apps/google-bridge/test/response-shape.test.ts` が `Object.keys(body).sort()` と `["access_token","expires_in","scope","token_type"]` の完全一致を assert し green。（実体は `apps/google-bridge/test/bridge.spec.ts`）
- [x] `token_type` が常に `"Bearer"` であることと、応答に `cnf` キーが無いことを assert するテストが green。（実体は `apps/google-bridge/test/bridge.spec.ts`）
- [x] `bash scripts/check-bridge-no-refresh-token.sh` が終了コード0で、`token.ts` に `refresh_token` を1行追記すると非ゼロ終了する。
- [x] `grep -rn "DPoP" apps/google-bridge/src/token/ apps/google-bridge/src/saas/` の出力が0行。

---

### T-BRIDGE-11 アウトバウンド許可リストを実装し業務 API の中継経路を持たせない

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。
docs 06 §2 の「担当しない」を、送信先ホストの許可リストで機械的に強制する（RULE-21）。
Bridge のコードからの HTTP 送信先を Connector Definition の endpoint と ID トークン検証用の Google ホストに限り、それ以外は例外にする。

**対象要件** REQ-06-008
**前提タスク** T-BRIDGE-03
**成果物** `apps/google-bridge/src/http/outbound.ts`, `apps/google-bridge/test/outbound-allowlist.test.ts`, `.eslintrc.cjs`（`no-restricted-globals` に `fetch` を追加）, `scripts/check-bridge-raw-fetch.sh`

**実装方針**
- `bridgeFetch(url: string, init: RequestInit, allowed: AllowedHosts)` を実装する。`AllowedHosts` は `Set<string>` で、要素はホスト名のみ（スキームとパスを含めない）。
- 許可ホストは要求ごとに組み立てる。内訳は (1) 当該 Connector Definition の `token_endpoint` / `revocation_endpoint` / `userinfo_endpoint` / `authorization_endpoint` のホスト、(2) `www.googleapis.com`（呼び出し元 ID トークン検証の JWKS）、(3) `config.jwksUrl` のホスト（共有 JWKS）。この3系統以外を足さない。
- KMS / Secret Manager / Firestore はクライアント SDK（gRPC）で呼ぶため `bridgeFetch` を通らない。許可リストに書かず、代わりに「SDK 経由の GCP API はこのラッパの対象外」であることをファイル冒頭のコメントに明記する。
- URL のスキームが `https:` でなければ例外。ホストが許可リストに無ければ `OutboundNotAllowedError` を投げ、握りつぶさない。リダイレクトは `redirect: "manual"` にして追随しない。
- ESLint の `no-restricted-globals` に `fetch` を追加し、`src/http/outbound.ts` だけを対象外にする。`scripts/check-bridge-raw-fetch.sh` は `apps/google-bridge/src` から `outbound.ts` を除いて `fetch(` を grep し、見つかったら非ゼロ終了する。
- Gmail / Calendar / ドキュメントの API パスを Bridge のルートにも許可ホストにも入れない。プロキシ用のハンドラを1本も作らない。

**完了条件**
- [x] `apps/google-bridge/test/outbound-allowlist.test.ts` で `https://evil.example.com/` への `bridgeFetch` が `OutboundNotAllowedError` になる。（実体は `apps/google-bridge/test/bridge.spec.ts`）
- [x] `http://` の URL が例外になるテストと、302 応答に追随しないテストが green。（実体は `apps/google-bridge/test/bridge.spec.ts`）
- [x] `bash scripts/check-bridge-raw-fetch.sh` が終了コード0で、任意の src ファイルに `fetch(` を1行足すと非ゼロ終了する。
- [x] T-BRIDGE-01 のルートスナップショットに `/calendar` `/gmail` `/proxy` のいずれの接頭辞も現れない。（実体は `apps/google-bridge/test/routes-snapshot.spec.ts`）

---

### T-BRIDGE-12 Bridge のログ7項目と Protocol Validation イベントを出力する

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。
docs 09 §2 が求める Bridge のログ項目を、共通の構造化ログヘルパ経由で出す（RULE-38）。
出力フィールドを許可リストで固定し、トークン本体がログへ入らないようにする。

**対象要件** REQ-09-010, REQ-09-029
**前提タスク** T-BRIDGE-07, T-BRIDGE-09
**成果物** `apps/google-bridge/src/log/bridge-log.ts`, `apps/google-bridge/schemas/bridge-token-log.schema.json`, `apps/google-bridge/test/bridge-log.spec.ts`, `e2e/test/bridge-log.spec.ts`

**実装方針**
- `/token` の1リクエストにつき `event: "bridge_token_exchange"` の構造化ログを1件出す。フィールドは7項目に固定する。`id_jag_issuer`、`id_jag_validation`（`ok` | エラーコード）、`connection_id`、`requested`（`{ resource, scope }` のオブジェクト）、`binding_expiry_check`（`ok` | `expired_binding` | `expired_connection`）、`saas_refresh_result`（`ok` | `rotated` | `revoked` | `error`）、`token_issue_result`（`issued` | `denied`）。
- 「要求された resource と scope」は `requested` の1フィールドにまとめる。これで docs 09 §2 の列挙が7項目に収まる。
- 出力は `@xaa/contracts` の共通ログヘルパ（T-SEC-07 が CI で強制する経路）を通す。`console.log` を直接呼ばない。
- 値の許可リストを `bridge-log.ts` の1定数に置き、許可外のキーが渡されたら開発時は例外、本番はキーを落として出力する。`access_token` / `refresh_token` / `client_secret` / `assertion` / `code` / `code_verifier` / `state` の7キーは常に落とす。
- 失敗経路でも同じ7項目を出す。到達しなかった段階は `"skipped"` を入れ、フィールド自体を省略しない。
- Protocol Validation イベントの送出は T-BRIDGE-06 / T-BRIDGE-07 / T-BRIDGE-08 の各拒否点で行い、本タスクではイベント名の一覧（`forbidden_bridge_caller`, `invalid_bridge_binding`, `expired_bridge_connection`, `bridge_scope_violation`, `invalid_dpop_proof`, `replayed_dpop_proof`）を1ファイルの定数として固定する。
- Callback 面のログには `state` と `code` を出さない。出すのは `connector_id` と `transaction_id` と結果コードに限る。

**完了条件**
- [x] `e2e/test/bridge-log.spec.ts` が払い出し成功1回と期限切れ拒否1回を実行し、両方のログに7項目がそろっていることを assert して green。（実体は `e2e/test/bridge/bridge-log.spec.ts`）
- [x] ログ本文に `access_token` の値（stub が返す固定文字列）が現れないことを assert するテストが green。（実体は `apps/google-bridge/test/bridge-log.spec.ts`）
- [~] 許可外キーを渡す単体テストが開発モードで例外になり、本番モードでキーが落ちることを確認できる。（デプロイ後に `scripts/deploy-gcp-guide.sh` の verify 段が観測する）
- [x] `expired_bridge_connection` イベントが期限切れ拒否1回につき1件だけ記録されることを assert できる。（実体は `e2e/test/bridge/bridge-log.spec.ts`）

---

### T-BRIDGE-13 Check Connection API を実装し再 Consent を回避する

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。
Provisioner が Provisioning の途中で呼ぶ `POST /connections/check` を実装する（RULE-24）。
Connection が ACTIVE で必要 scope を満たすなら必ず READY を返し、同じ人間の2体目以降の Agent でブラウザ操作を発生させない。

**対象要件** REQ-06-012, REQ-06-018
**前提タスク** T-BRIDGE-02, T-BRIDGE-04, T-BRIDGE-08
**成果物** `apps/google-bridge/src/routes/connections-check.ts`, `apps/google-bridge/schemas/connections-check.schema.json`, `apps/google-bridge/test/connections-check.test.ts`

**実装方針**
- 要求本文は `{ connector_id, human_subject, required_scopes: string[] }` の3キー固定。Ajv（`additionalProperties:false`）で検証し、違反は 400。
- 応答は2形。充足時が `{ status: "READY", connection_id }`、不足時が `{ status: "CONSENT_REQUIRED", consent_url, missing_scopes }`。3つ目の形を作らない。
- 判定は `connection.status === "ACTIVE"` かつ `connection.expires_at > now` かつ `isSubset(required, granted)`（T-BRIDGE-08 の関数）。行が無い、`EXPIRED`、`REVOKED`、scope 不足のいずれも `CONSENT_REQUIRED`。
- `missing_scopes` は `required_scopes` から `granted_scopes` を引いた差集合のみを昇順で返す。`required_scopes` 全体を返さない。
- `consent_url` は `${config.bridgeCallbackBaseUrl}/${connector_id}/oauth/start?transaction_id=${transaction_id}` の形で組み立てる。`transaction_id` は要求本文には含めず、Provisioner が `POST /connections/check` の前に作った Transaction の ID をヘッダ `X-Transaction-Id` で渡す。Bridge 側で Transaction を新規作成しない。
- 呼び出せるのは `sa-provisioner` のみ。`callerAuthz(["provisioner"])` を適用する（T-BRIDGE-02）。
- READY を返すときに Binding を作らない。Binding 作成は Provisioner が `POST /bindings` を呼んで行う（T-BRIDGE-18）。
- Connection の有無で Consent 画面を出すかどうかを Bridge が決める分岐は持たない。Bridge は判定結果だけを返し、リダイレクトの実行は Automation App の責務にする。

**完了条件**
- [x] `apps/google-bridge/test/connections-check.test.ts` の `未接続 -> CONSENT_REQUIRED` / `scope不足 -> CONSENT_REQUIRED + missing_scopes は差分のみ` / `充足 -> READY + connection_id` の3ケースが green。（実体は `apps/google-bridge/test/connections-check.spec.ts`）
- [x] `status=REVOKED` の Connection が `CONSENT_REQUIRED` になるテストが green。（実体は `apps/google-bridge/test/connections-check.spec.ts`）
- [x] 同じ `human_subject` で2回連続して呼び、2回目も `READY` を返し `bridge_connections` の件数が1のままであることを assert できる。（実体は `apps/google-bridge/test/connections-check.spec.ts`）
- [x] `runtime` SA からの呼び出しが 403 `forbidden_caller` になるテストが green。（実体は `apps/google-bridge/test/connections-check.spec.ts`）

---

### T-BRIDGE-14 Consent 開始エンドポイントを実装する

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。
callback 面の `GET /{connector_id}/oauth/start` を実装する（RULE-23）。
Transaction の状態を確認したうえで state と PKCE を用意し、外部の認可エンドポイントへリダイレクトする。オープンリダイレクトを作らない。

**対象要件** REQ-06-013
**前提タスク** T-BRIDGE-03, T-BRIDGE-04
**成果物** `apps/google-bridge/src/routes/oauth-start.ts`, `apps/google-bridge/src/consent/state-store.ts`, `apps/google-bridge/src/consent/pkce.ts`, `apps/google-bridge/test/oauth-start.test.ts`

**実装方針**
- 手順は (a) Provisioner の内部 API `GET ${PROVISIONER_BASE_URL}/internal/transactions/{transaction_id}` を呼び、`status === "WAITING_EXTERNAL_CONSENT"` を確認 → (b) state を生成 → (c) PKCE を生成 → (d) 302 の順に固定する。
- state は `crypto.randomBytes(32)` を base64url した文字列。`bridge_consent_states/{state}` に `{ transaction_id, connector_id, human_subject, required_scopes, code_verifier, created_at, expire_at }` を書き、`expire_at = now + 600 秒`。
- PKCE は `code_verifier` を 43 文字以上のランダム文字列、`code_challenge` を SHA-256 の base64url とし、`code_challenge_method=S256` を必ず付ける。`plain` を使う分岐を作らない。
- リダイレクト先の query は `client_id`、`redirect_uri`（`${config.bridgeCallbackBaseUrl}/${connector_id}/oauth/callback`）、`response_type=code`、`scope`（required_scopes を空白区切り）、`state`、`code_challenge`、`code_challenge_method=S256`、`access_type=offline`、`prompt=consent` の9キーに固定する。
- リダイレクト先のホストは Connector Definition の `authorization_endpoint` からのみ組み立てる。リクエストのパラメータからホストを組み立てる経路を作らない。
- `transaction_id` が不明、期限切れ、`status` が違う場合は HTTP 400 を返し、外部へ 302 しない。エラー本文は `{"error":"invalid_transaction"}` に固定し、Transaction の中身を返さない。
- 応答前に `assertNoTokenInRedirect(location)`（T-BRIDGE-16）を通す。
- Consent 画面を Bridge 側で描画しない。

**完了条件**
- [x] `apps/google-bridge/test/oauth-start.test.ts` の `unknown transaction_id -> 400 かつ Location ヘッダ無し` が green。（実体は `apps/google-bridge/test/oauth-start.spec.ts`）
- [x] 正常系の `Location` に `state`、`code_challenge`、`code_challenge_method=S256`、`access_type=offline`、`prompt=consent` がすべて含まれることを assert している。（実体は `apps/google-bridge/test/oauth-start.spec.ts`）
- [x] `Location` の query キー集合が上記9キーと完全一致することを assert するテストが green。（実体は `apps/google-bridge/test/oauth-start.spec.ts`）
- [x] `status` が `WAITING_EXTERNAL_CONSENT` 以外の Transaction で 400 になるテストが green。（実体は `apps/google-bridge/test/oauth-start.spec.ts`）

---

### T-BRIDGE-15 OAuth Callback を処理し Connection を upsert する

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。
`GET /{connector_id}/oauth/callback` で state を単回消費し、認可コードを交換して Connection を作る（RULE-23）。
完了後は Automation App へ `transaction_id` と one-time code の2つだけを載せて戻す。

**対象要件** REQ-06-014
**前提タスク** T-BRIDGE-14, T-BRIDGE-09, T-BRIDGE-16
**成果物** `apps/google-bridge/src/routes/oauth-callback.ts`, `apps/google-bridge/src/consent/one-time-code.ts`, `apps/google-bridge/test/oauth-callback.test.ts`

**実装方針**
- state の消費は Firestore の `runTransaction` で `bridge_consent_states/{state}` を読み、存在すれば削除して内容を返す。存在しなければ 400 `{"error":"invalid_state"}`。読み取りと削除を分けて書かない。
- code 交換は `bridgeFetch` で Connector の `token_endpoint` へ `grant_type=authorization_code`、`code`、`redirect_uri`、`client_id`、`client_secret`、`code_verifier` を POST する。
- `external_subject` は、応答に `id_token` があればその `sub`、無ければ `userinfo_endpoint` の応答から Connector Definition の `subject_claim` が指すキーで取る。両方取れなければ交換失敗として扱う。
- Connection は `${connector_id}:${sha256(human_subject)}` の決定的 ID で upsert する。既存があれば `granted_scopes` を既存と新規の和集合で更新し、`encrypted_refresh_token` を新しい暗号文で上書き、`status="ACTIVE"`、`expires_at = now + connection_max_age_seconds` を設定する。既存の `created_at` は保つ。
- 交換応答の初回 `access_token` は Firestore へ書かず、関数のローカル変数のまま処理を終える。
- one-time code は `crypto.randomBytes(32)` の base64url。`bridge_consent_codes/{code}` に `{ transaction_id, connection_id, expire_at: now + 300 秒 }` を書く。
- 成功時は `${AUTOMATION_APP_BASE_URL}/consent/complete?transaction_id=...&code=...` へ 302 する。query キーは `transaction_id` と `code` の2つだけ。
- 失敗時は `${AUTOMATION_APP_BASE_URL}/consent/failed?transaction_id=...&reason=<slug>` へ 302 する。`reason` の値は `invalid_state` | `code_exchange_failed` | `subject_unresolved` の3語に固定し、例外メッセージや SaaS の応答本文を載せない。
- 302 を返す直前に `assertNoTokenInRedirect(location)` を通す。

**完了条件**
- [x] `apps/google-bridge/test/oauth-callback.test.ts` で正常系の `Location` の query キー集合が `["code","transaction_id"]` と完全一致する。（実体は `apps/google-bridge/test/oauth-callback.spec.ts`）
- [x] 同じ state を2回使うと2回目が 400 `invalid_state` になり、302 が返らないテストが green。（実体は `apps/google-bridge/test/oauth-callback.spec.ts`）
- [x] code 交換失敗時の `Location` の query キー集合が `["reason","transaction_id"]` と完全一致し、`reason` が3語のいずれかであるテストが green。（実体は `apps/google-bridge/test/oauth-callback.spec.ts`）
- [x] 既存 Connection がある状態で scope 追加の Consent を通すと `granted_scopes` が和集合になり、行数が増えないことを assert できる。（実体は `apps/google-bridge/test/oauth-callback.spec.ts`）

---

### T-BRIDGE-16 リダイレクトにトークンを載せないことを共通関数で強制する

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。ただし関数そのものは Bridge と Agent OP の両方が使うため、既定 apply でもビルド対象に含める。
すべての 302 Location を1つのガード関数に通し、禁止キーと JWT 形式の値が query と fragment に入らないことを保証する（RULE-23）。

**対象要件** REQ-06-015
**前提タスク** なし
**成果物** `packages/xaa-contracts/src/redirect-guard.ts`, `packages/xaa-contracts/test/redirect-guard.spec.ts`, `e2e/support/redirect-guard-hook.ts`

**実装方針**
- `assertNoTokenInRedirect(location: string): void` を実装する。戻り値を持たせず、違反時に `RedirectGuardError` を投げる。真偽値を返す形にしない（呼び出し側が結果を無視できてしまうため）。
- 検査対象は URL の query と fragment の両方。fragment は `#` 以降を同じ `URLSearchParams` で解析する。
- 禁止キーは `access_token`, `refresh_token`, `id_token`, `client_secret`, `assertion`, `code_verifier` の6つ。キー名の比較は小文字化して行う。
- 値の形状検査は「ドットで区切った3セグメントで、各セグメントが base64url 文字のみ」を JWT 形式とみなす。キー名が許可されていても値が JWT 形式なら違反にする。
- `code` と `state` と `transaction_id` は禁止キーに含めない。これらは仕様上 URL に載る。
- Bridge の 302 は `oauth-start.ts` と `oauth-callback.ts` の2か所、Agent OP は `/xaa/callback` が呼び出し元になる。呼び出しは応答生成の直前に置き、例外時は 500 を返して 302 を送らない。
- `e2e/support/redirect-guard-hook.ts` は Playwright の `page.on("response")` で 3xx の `Location` を拾い、同じ関数へ通す。E2E 側で個別に assert を書かない。

**完了条件**
- [x] `packages/xaa-contracts/test/redirect-guard.spec.ts` が6つの禁止キーそれぞれで例外を投げることを確認して green。
- [x] fragment に `#access_token=...` を置いた URL で例外になるテストが green。（実体は `packages/xaa-contracts/test/redirect-guard.spec.ts`）
- [x] 許可キー `code` の値に JWT 形式の文字列を入れた URL で例外になるテストが green。
- [x] `?transaction_id=abc&code=xyz` が例外にならないテストが green。

---

### T-BRIDGE-17 Verify Connection をサーバ間 API として実装する

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。
Consent 復帰後に Provisioner が呼ぶ `POST /connections/verify` を実装する（RULE-23）。
one-time code を単回消費し、Connection が要求 scope を満たすことを確認して READY を返す。

**対象要件** REQ-06-016
**前提タスク** T-BRIDGE-02, T-BRIDGE-15
**成果物** `apps/google-bridge/src/routes/connections-verify.ts`, `apps/google-bridge/schemas/connections-verify.schema.json`, `apps/google-bridge/test/connections-verify.test.ts`

**実装方針**
- 要求本文は `{ transaction_id, one_time_code }` の2キー固定。Ajv（`additionalProperties:false`）で検証する。
- code の消費は Firestore の `runTransaction` で `bridge_consent_codes/{one_time_code}` を読み、存在すれば削除して内容を返す。存在しなければ HTTP 400 と `{"error":"code_already_used"}`。有効期限切れも同じコードに寄せる。
- 消費した code の `transaction_id` が要求本文の `transaction_id` と一致しなければ 400 `code_already_used`。この場合も code は消費済みのままにする（再利用させない）。
- Connection が `ACTIVE` で、Transaction の `required_scopes`（Provisioner の内部 API から取得）が `granted_scopes` の部分集合であれば `{ status: "READY", connection_id, granted_scopes }` を返す。満たさなければ 409 と `{"error":"scope_not_in_connection"}`。
- 呼び出せるのは `sa-provisioner` のみ。`callerAuthz(["provisioner"])` を適用する。
- このルートは internal 面にだけマウントする。callback 面へマウントしない。ブラウザから到達する経路を作らない。
- Binding をここで作らない。

**完了条件**
- [x] `apps/google-bridge/test/connections-verify.test.ts` で同一 `one_time_code` の2回目が 400 `code_already_used` になる。（実体は `apps/google-bridge/test/connections-verify.spec.ts`）
- [x] `runtime` SA からの呼び出しが 403 `forbidden_caller` になるテストが green。（実体は `apps/google-bridge/test/connections-verify.spec.ts`）
- [x] 正常系で `granted_scopes` が昇順の配列として返るテストが green。（実体は `apps/google-bridge/test/connections-verify.spec.ts`）
- [x] callback 面の `createCallbackApp()` に `/connections/verify` が存在しないことをルートスナップショットで確認できる。（実体は `apps/google-bridge/test/routes-snapshot.spec.ts`）

---

### T-BRIDGE-18 Agent Binding の作成と無効化と削除の API を実装する

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。
Provisioner が Binding を作り、Lifecycle Manager が無効化してから削除する経路を実装する（RULE-24、RULE-25）。
作成時の4条件をすべて検査し、Connection に無い scope を持つ Binding を作らせない。

**対象要件** REQ-06-017, REQ-06-011
**前提タスク** T-BRIDGE-04, T-BRIDGE-08, T-BRIDGE-02
**成果物** `apps/google-bridge/src/routes/bindings.ts`, `apps/google-bridge/schemas/binding-create.schema.json`, `apps/google-bridge/test/bindings-api.test.ts`, `apps/google-bridge/test/binding-lifecycle.test.ts`

**実装方針**
- `POST /bindings` の本文は `{ agent_id, connector_id, connection_id, human_subject, scopes, expires_at }` の6キー固定。`expires_at` は RFC 3339 の UTC 文字列。
- 検査順序は (a) `isSubset(scopes, connection.granted_scopes)` → 違反は 400 `scope_not_in_connection`、(b) `connection.human_subject === human_subject` → 違反は 400 `human_subject_mismatch`、(c) `expires_at <= now + min(86400, AGENT_MAX_LIFETIME_SECONDS)` → 違反は 400 `expires_at_too_far`、(d) `create()` の ALREADY_EXISTS → 400 `binding_already_exists` に固定する。理由コードを1つにまとめない。
- 成功時は HTTP 201 と `{ binding_id, expires_at }` を返す。`scopes` や `connection_id` を応答に載せない。
- `POST /bindings/{agent_id}/disable` は当該 `agent_id` を接頭辞に持つ `agent_bindings` の全行を `status="DISABLED"` に更新し、HTTP 204 を返す。対象が0件でも 204（冪等）。
- `DELETE /bindings/{agent_id}` は同じ範囲の行を削除し、HTTP 204 を返す。対象が0件でも 204（冪等）。`bridge_connections` の行に触れない。
- 削除は `agent_id` を接頭辞にした doc ID の範囲クエリで引く。全件走査してアプリ側でフィルタする実装にしない。
- `POST /bindings` は `callerAuthz(["provisioner"])`、`disable` と `DELETE` は `callerAuthz(["lifecycle"])` を適用する。
- Lifecycle Cleanup（T-LIFE-04）は disable を先に呼び、完了時に DELETE を呼ぶ。この順序を Bridge 側で強制しない（disable 無しの DELETE も 204 で受ける）。

**完了条件**
- [x] `apps/google-bridge/test/bindings-api.test.ts` の7ケース（正常201 / scope超過 / human_subject不一致 / 24h超過 / 重複 / disable冪等 / delete冪等）が期待どおりのステータスと理由コードを返す。（実体は `apps/google-bridge/test/bindings-api.spec.ts`）
- [x] `apps/google-bridge/test/binding-lifecycle.test.ts` で、DELETE 後に当該 `agent_id` の行が0件になり、同じ `connection_id` を参照する別 Agent の Binding と `bridge_connections` の行が残ることを assert できる。（実体は `apps/google-bridge/test/bindings-api.spec.ts`）
- [x] `provisioner` SA から `DELETE /bindings/{agent_id}` を呼ぶと 403 `forbidden_caller` になるテストが green。（実体は `apps/google-bridge/test/bindings-api.spec.ts`）
- [x] `AGENT_MAX_LIFETIME_SECONDS=3600` の設定下で `expires_at` を2時間後にすると 400 `expires_at_too_far` になるテストが green。（実体は `apps/google-bridge/test/bindings-api.spec.ts`）

---

### T-BRIDGE-19 stub-saas-op と stub-saas-api を実装する

**概要**
`enable_google_bridge=true` のときのみ有効なタスク。
外部の Google に接続せずに Bridge 経路を通すため、SaaS 側の OAuth AS と業務 API をスタブとして用意する（REQ-01-024 の「外部 Google に接続しないスタブ AS / API」）。
stub-saas-op は maronn の CLI 生成物を使い、stub-saas-api は Bearer 提示だけを検証する最小の Hono アプリにする。

**対象要件** REQ-01-024
**前提タスク** なし
**成果物** `apps/stub-saas-op/src/index.ts`（手書きの最小 OP。`apps/stub-saas-op/src/oidc/` と `generated-baseline/stub-saas-op/` は作らず、CLI 生成物を使わない。理由は DEC-ID-01 の注記）, `apps/stub-saas-api/src/index.ts`, `apps/stub-saas-api/src/routes/calendar.ts`, `apps/stub-saas-api/test/calendar.spec.ts`, `apps/stub-saas-op/test/refresh-rotation.spec.ts`

**実装方針**
- stub-saas-op は当初 DEC-ID-01 に従い `maronn-oidc generate hono` の生成物を使う計画だったが、実装では約140行の手書き Hono アプリにした。テスト専用のフィクスチャであって本 platform が運用する OP ではなく、認証画面なしの `/authorize` や HMAC トークンなど stub 固有の挙動を XAA-PATCH で生成物へ載せる価値が無いためである（DEC-ID-01 の注記）。`scripts/check-oidc-patches.mjs` の対象からも外す。
- 提供するエンドポイントは `/authorize`、`/token`、`/userinfo`、`/.well-known/openid-configuration` の4本。`/authorize` は認証画面を出さず、固定の external subject `stub-user-001` で即座に認可コードを発行する。Consent 画面のクリック操作を E2E に持ち込まない。
- `/token` は `authorization_code`（PKCE 必須、`code_challenge_method=S256` 以外を拒否）と `refresh_token` の2つの grant を受ける。`client_secret` の一致検証を行う。
- Refresh Token の rotation は環境変数 `STUB_ROTATE_REFRESH_TOKEN`（`always` | `never`、既定 `never`）で切り替える。`always` のとき `/token` の応答へ新しい `refresh_token` を含める。
- 失効の再現用に `POST /internal/revoke-refresh-token` を持たせ、以後の `refresh_token` grant が `{"error":"invalid_grant"}` を返すようにする。これは stub にだけ置き、Bridge 側に対応するコードを足さない。
- stub-saas-api は `GET /calendar/events?from=&to=` の1本と `GET /livez` のみ。`Authorization: Bearer <token>` を stub-saas-op の introspection ではなく共有の HMAC 検証で確認し、`scope` に `calendar.read` が含まれることを確認する。DPoP ヘッダを要求する分岐を実装しない（REQ-05-023）。
- 応答は `{ events: [{ event_id, title, starts_at }] }` の固定3件。Tool ID `stub.calendar.events.list` の `response_schema` と一致させる。
- 2つのアプリは `saas_connector_mode=stub` かつ `enable_google_bridge=true` のときだけデプロイされる。既定 apply では作られない。

**完了条件**
- [x] `apps/stub-saas-op/test/refresh-rotation.spec.ts` で `STUB_ROTATE_REFRESH_TOKEN=always` のとき応答に新しい `refresh_token` が含まれ、`never` のとき含まれないことを確認できる。
- [x] `POST /internal/revoke-refresh-token` の後の `refresh_token` grant が `invalid_grant` を返すテストが green。
- [x] `apps/stub-saas-api/test/calendar.spec.ts` で、`calendar.read` を含む Bearer が 200、含まない Bearer が 403、ヘッダ無しが 401 になる。
- [x] stub-saas-op は手書きの最小 OP（DEC-ID-01 の注記）であり CLI 生成物を持たないため再生成チェックの対象外。`node scripts/check-oidc-patches.mjs` が stub-saas-op を対象から外したまま終了コード 0 で通り、`bash scripts/regenerate-oidc.sh --check` が残る3系統の生成物と一致する

---

### T-BRIDGE-20 Bridge 経路の E2E と既定 apply での非生成を検査する

**概要**
`enable_google_bridge=true` のときのみ実行するタスク。
docs 01 §4 の Bridge 経路（Agent → ID-JAG → Bridge → Refresh Token Grant → Access Token → SaaS API）を stub 相手に通す E2E を作る。
同時に、既定の `enable_google_bridge=false` では Bridge の Cloud Run Service が plan に現れず、この E2E がスキップされることを機械的に確かめる。

**対象要件** REQ-01-024, REQ-06-018, REQ-06-022
**前提タスク** T-BRIDGE-10, T-BRIDGE-15, T-BRIDGE-17, T-BRIDGE-18, T-BRIDGE-19
**成果物** `e2e/test/bridge-flow.spec.ts`, `e2e/test/second-agent-no-consent.spec.ts`, `infra/tests/bridge-disabled-plan.sh`, `e2e/support/bridge-enabled.ts`

**実装方針**
- `e2e/support/bridge-enabled.ts` は環境変数 `ENABLE_GOOGLE_BRIDGE` を読み、`true` 以外のとき Playwright の `test.skip()` を呼ぶ。Bridge 系の spec はすべて先頭でこれを呼ぶ。条件を各 spec に散らさない。
- `e2e/test/bridge-flow.spec.ts` の手順は (1) ログイン、(2) Provisioning 要求、(3) `CONSENT_REQUIRED` を受けて stub-saas-op の `/authorize` へ遷移、(4) callback で Automation App へ復帰、(5) Provisioner が `/connections/verify` と `/bindings` を呼ぶ、(6) Agent Runtime が Agent OP から ID-JAG を取得、(7) Bridge の `/token` へ DPoP 付きで提示、(8) 返った Access Token を Bearer で stub-saas-api の `/calendar/events` へ提示、(9) 3件のイベントが返る、の9段階に固定する。
- (7) の応答に `cnf` が無いこと、(8) が DPoP ヘッダ無しで 200 になることを assert する（REQ-05-023）。
- `e2e/test/second-agent-no-consent.spec.ts` は同じ `human_subject` で2体目の Provisioning を行い、stub-saas-op の `/authorize` へのナビゲーションが0回であること、`bridge_connections` の件数が1のままであること、2体目が `ACTIVE` に到達することを assert する。
- 全リダイレクトに `e2e/support/redirect-guard-hook.ts`（T-BRIDGE-16）を適用する。
- `infra/tests/bridge-disabled-plan.sh` は `terraform plan -var enable_google_bridge=false -json` の出力から `google_cloud_run_v2_service` の `name` を抽出し、`google-bridge` / `google-bridge-callback` / `stub-saas-op` / `stub-saas-api` のいずれも現れないことを確認する。現れたら非ゼロ終了する。
- Terraform の Bridge 定義そのものは infra 領域が持つ。本タスクでは plan の結果だけを検査し、`.tf` を編集しない。
- 実 Google へ接続する E2E を書かない。`saas_connector_mode=google` の経路はテスト対象にしない。

**完了条件**
- [x] `ENABLE_GOOGLE_BRIDGE=true pnpm test:e2e -- bridge/bridge-flow` が9段階すべてを通って green。
- [x] 同じコマンドで `/token` の応答に `cnf` が無く、stub-saas-api への呼び出しが DPoP ヘッダ無しで 200 になることを assert している。
- [x] `pnpm test:e2e`（`ENABLE_GOOGLE_BRIDGE` 未設定）で Bridge 系 spec が skipped と報告され、failed が0件。
- [x] `bash infra/tests/bridge-disabled-plan.sh` が終了コード0で、`enable_google_bridge=true` に変えて実行すると非ゼロ終了する。
- [x] `ENABLE_GOOGLE_BRIDGE=true pnpm test:e2e -- bridge/second-agent-no-consent` で `/authorize` への遷移が0回、`bridge_connections` が1件のまま green。
