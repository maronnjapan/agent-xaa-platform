# 00b. 実装規約（識別子と成果物の所有者）

13領域のタスクファイルは並行に書き起こしたため、同じものに別の名前が付いた箇所が残った。
本ファイルはその全件を1つの値へ確定させる。

**各タスクファイルの本文と本ファイルが食い違う場合、本ファイルの値が正しい。**
実装者は識別子と成果物の所有者の判断をここだけで行う。
新しい識別子を増やすときも、まずこの表へ足してからコードを書く。


この規約は、13本のタスクファイルで別名になっている識別子と、二重所有になっている成果物を、実装できる1つの値と1人の所有者に確定させる。
確定の優先順位は 00-decisions.md、findings.md の fix 欄、タスクファイル内の出現数の順であり、両者が衝突した箇所は 00-decisions.md の値を採った。
タスクファイルを直す13人と実装者は、値と所有者の判断をここだけで行い、各タスクファイルの本文をこの表に合わせて書き換える。

## 1. 識別子

| 対象 | 確定値 | 採用しない別名 | この値を使う主なタスク |
|---|---|---|---|
| agent_id の採番 | `agent-` + 16バイト乱数を base32（RFC 4648、小文字、パディング無し）で符号化した26文字 | `agent_` + base64url、`agent-01hxyz1234` のような桁数不定の例 | T-PROV-18 |
| agent_id の正規表現 | `^agent-[0-9a-z]{26}$` | `^agent-[0-9a-z-]{8,}$`、`^agent-[0-9a-z-]{1,60}$`、「`agent-` 接頭辞を持つ」 | T-PKG-18 が定義、T-OP-09 / T-OP-15 / T-OP-18 が呼ぶ |
| agent_id 検査関数の置き場 | `packages/xaa-contracts/src/agent-namespace.ts` の `isAgentId(value)` と `assertAgentId(value)` | Agent OP 側の `isAgentId` 再定義 | T-PKG-18 |
| Agent の URN | `urn:xaa:agent:<agent_id>` | なし | T-PKG-18 の `toAgentUrn` / `parseAgentUrn` / `AGENT_URN_PREFIX` |
| actor_token の JOSE typ | `agent-assertion+jwt`（定数名 `ACTOR_TOKEN_TYP`） | `ACTOR_TOKEN_TYPE`、`toActorSub` | T-PKG-18 が定義、T-OP-13 / T-RUN-09 が import |
| Agent Client Credential の typ | `agent-client-auth+jwt` | なし | T-OP-09 |
| ID-JAG の typ | `oauth-id-jag+jwt` | なし | T-OP-07 |
| Access Token の typ | `at+jwt` | なし | T-IDP-18 / T-AUTHZ-05 |
| 受領側の grant_type | `urn:ietf:params:oauth:grant-type:jwt-bearer`（定数 `JWT_BEARER_GRANT_TYPE`） | `jwt-dpop` | T-RES-06 / T-BRIDGE-05 |
| client_id | `agent-platform`（定数 `PLATFORM_CLIENT_ID`） | Agent ごとのクライアント登録 | T-PKG-16 が定義、T-RUN / T-OP が使う |
| Agent の status 値域 | `CREATED` / `PROVISIONING` / `ACTIVE` / `EXPIRING` / `EXPIRED` / `SUSPICIOUS` / `QUARANTINED` / `REVOKED` / `DESTROYED` の9値 | 3値、4値、5値 | T-LIFE-02 が定義、T-PROV-18 / T-PKG-20 / T-OP-02 / T-APP-13 / T-SEC-34 が従う |
| Provisioner が書ける status | `CREATED` / `PROVISIONING` / `ACTIVE` の3値のみ | `transitionStatus` による任意遷移 | T-PROV-18 / T-PROV-19 |
| Provisioning Transaction の status | `CREATED` / `WAITING_IDP_CONSENT` / `WAITING_EXTERNAL_CONSENT` / `RESUMABLE` / `PROVISIONING` / `COMPLETED` / `FAILED` / `ABANDONED` の8値 | `RESUMED` | T-PROV-13 が定義、T-OP-25 が従う |
| Isolation Slot の status | `free` / `allocated` の2値（小文字） | `FREE` / `ASSIGNED` | T-PROV-24 / T-PROV-26 / T-LIFE-09 |
| Isolation の水準 | `standard` / `full_isolation` | `shared`、`ISOLATION_MODE` 由来の値 | T-RUN-01 / T-PROV-05 / T-IAC-12 / T-IAC-13 |
| Human IdP の kid | `idp-<公開 JWK の RFC 7638 thumbprint を base32 小文字で符号化した先頭8文字>` | 乱数8文字 | T-IDP-03 |
| 共有 Agent OP の kid | `op-shared-<KMS CryptoKeyVersion の末尾番号>` | `agent-op-*`、`idjag-aaaaaaaaaaaa-1` | T-PKG-13 / T-OP-05 / T-OP-06 |
| Dedicated Agent OP の kid | `idjag-<short>-<KMS CryptoKeyVersion の末尾番号>` | `op-slot-<nn>-<v>`、`dedicated-op-<short>-<v>` | T-PKG-13 / T-OP-05 / T-OP-06 |
| Docs Resource AS の kid | `docs-as-<thumbprint 先頭8文字>` | `res-docs-*` | T-RES-04 |
| Finance Resource AS の kid | `fin-as-<thumbprint 先頭8文字>` | `res-finance-*` | T-RES-04 |
| JWKS の kid 接頭辞の全集合 | `idp-` / `op-shared-` / `idjag-<nn>-` / `docs-as-` / `fin-as-` の5種 | 上記以外 | T-IAC-21 / T-OP-06 |
| JWKS の個別オブジェクト | `keys/<kid>.json` | `keys/<prefix>-<kid>.json` の二重接頭辞 | T-IAC-13 / T-IAC-20 / T-IAC-21 |
| JWKS の集約オブジェクト | `jwks.json`（バケット直下、公開） | なし | T-IAC-21 の jwks-publish Job |
| Resource AS の署名鍵種別 | RSA-2048 の RS256 | ES256（P-256） | T-RES-04 |
| ID-JAG 署名の alg | ES256（KMS の EC_SIGN_P256_SHA256） | なし | T-OP-07 |
| PROTOCOL_VIOLATION_CODES | 22要素。`invalid_signature` / `expired_token` / `expired_agent` / `audience_mismatch` / `resource_mismatch` / `invalid_scope` / `unknown_issuer` / `invalid_client` / `invalid_id_jag` / `invalid_dpop_proof` / `replayed_dpop_proof` / `dpop_key_binding_mismatch` / `human_subject_mismatch` / `unauthorized_tool` / `expired_bridge_connection` / `expired_idp_connection` / `delegation_mismatch` / `xaa_config_out_of_range` / `forbidden_bridge_caller` / `invalid_bridge_binding` / `bridge_scope_violation` / `code_already_used` | 16要素固定 | T-SEC-11 が定義、T-OP-17 / T-OP-20 / T-OP-33 / T-BRIDGE-02 / T-BRIDGE-07 / T-BRIDGE-08 / T-PROV-15 が使う |
| EXTENDED_VALIDATION_CODES | `['refresh_token_reuse'] as const` の1要素 | 5要素案 | T-SEC-11 |
| delegation_match ステップの写像先 | `delegation_mismatch` | `human_subject_mismatch`（Control Plane の T-AUTHZ-07 専用として Agent OP から使わない） | T-OP-13 / T-OP-17 |
| Protocol Validation 送出関数 | `emitProtocolValidation(logger, ctx, ev)`（3引数） | 単一オブジェクト形、位置引数2つ形 | T-SEC-11 が定義、T-OP-11 / T-AUTHZ-07 / T-RUN-25 / T-BRIDGE-02 が呼ぶ |
| Capability ID の正規表現 | `^[a-z]+(\.[a-z_]+){1,2}$` | `^[a-z]+(\.[a-z]+){1,2}$` | T-PKG-16 の `assertValidCapabilityId` |
| Capability の全集合 | `calendar.event.read` / `calendar.event.write` / `mail.message.read` / `mail.message.send` / `document.read` / `document.write` / `finance.payment.read` / `finance.payment.approve` の8件 | ベンダー名や HTTP メソッド名を含む別名 | T-PKG-16 / T-AUTHZ-03 / T-IAC-26 |
| Resource AS の scope | `docs.read` / `docs.write` / `finance.tx.read` / `finance.tx.write` / `calendar.read` / `gmail.read` / `gmail.send` の7件 | なし | T-RES-15 / T-IAC-26 |
| Tool ID の全集合 | `internal.document.list` / `internal.document.get` / `internal.document.create` / `internal.document.update` / `internal.finance.payment.list` / `internal.finance.payment.get` / `internal.finance.payment.approve` / `stub.calendar.events.list` の8件 | `google.calendar.events.list`、`google.gmail.message.send`、`docs.document.get`、`finance.transaction.read` | T-PKG-16 の `TOOL_IDS`、T-SEC-21 は「8件」と書く |
| Connector ID の全集合 | `internal-docs-api` / `internal-finance-api` / `stub-saas-calendar` の3件 | `google-workspace` | T-PROV-01 の `CONNECTOR_IDS`、T-IAC-26 の seed |
| Connector と Tool の件数 | 既定は Connector 2件と Tool 7件。`ENABLE_GOOGLE_BRIDGE=true` で Connector 3件と Tool 8件 | Connector 3件と Tool 4件、Tool 8件固定 | T-IAC-26 |
| `authorization.type` の値域 | `native_xaa` / `xaa_bridge` の2値 | 値なし | T-PROV-06 / T-RUN-06 / T-RUN-13 |
| `token_provider` の値 | `authorization.type` が `xaa_bridge` のとき `platform_endpoints.bridge_internal_url` の絶対 URL、`native_xaa` のとき `null` | `resource_as` / `bridge` の列挙 | T-PROV-06 / T-RUN-14 |
| TOKEN_CATALOG のキー | `human_id_token_login` / `human_access_token` / `human_id_token_xaa` / `human_refresh_token_xaa` / `agent_assertion` / `id_jag` / `native_resource_access_token` / `saas_access_token` の8件、値は `{ typ, dpop }` | なし | T-PKG-16 の `packages/xaa-contracts/src/token-catalog.ts` |
| Capability から scope への写像 | `CAPABILITY_TO_SCOPE: Record<Capability, ResourceScope[]>`（`TOOL_BINDINGS` から導出） | 各アプリでの再定義 | T-PKG-16 が定義、T-SEC-20 が使う |
| SERVICE_IDS | `human-idp` / `shared-agent-op` / `agent-op-callback` / `automation-app` / `provisioner` / `authorization` / `lifecycle` / `resource-docs-as` / `resource-docs-api` / `resource-finance-as` / `resource-finance-api` / `stub-saas-op` / `google-bridge` の13件 | `agent-op`、`tool-catalog` | T-PKG-21 |
| Cloud Run Service 名（常設12件） | `human-idp` / `automation-app` / `authorization` / `provisioner` / `lifecycle` / `shared-agent-op` / `agent-op-callback` / `security-detection` / `resource-finance-as` / `resource-finance-api` / `resource-docs-as` / `resource-docs-api` | `automation-design-ai`、`authorization-ai-agent`、`policy-engine`、`tool-executor`、`tool-catalog`、`lifecycle-manager` | T-IAC-08 の `locals.service_names` |
| Cloud Run Service 名（条件付き4件） | `google-bridge` / `google-bridge-callback` / `stub-saas-op` / `stub-saas-api` | 条件付き3件 | T-IAC-08 / T-IAC-11 / T-BRIDGE-19 |
| Cloud Run Service 名（実行時作成） | `dedicated-op-<short>`、Job は `agent-runtime-<short>`。`<short>` は `agent_id` の乱数部の末尾12文字 | `dedicated-op-slot-<nn>` | T-PROV-24 |
| Service Account 台帳（19件） | `sa-human-idp` / `sa-automation-app` / `sa-authorization` / `sa-provisioner` / `sa-lifecycle` / `sa-shared-agent-op` / `sa-google-bridge` / `sa-security` / `sa-resource-finance-as` / `sa-resource-finance-api` / `sa-resource-docs-as` / `sa-resource-docs-api` / `sa-agent-runtime` / `sa-scheduler` / `sa-pubsub-push` / `sa-seed` / `sa-jwks-publish` / `sa-stub-saas-op` / `sa-stub-saas-api` | `sa-security-detection`、18件の台帳 | T-IAC-05、T-SEC-07 は `sa-security` を使う |
| Service Account（実行時作成） | `sa-op-<short>` と `sa-agent-<short>`。Terraform の SA 台帳には書かず Provisioner が作る | `sa-op-slot-<nn>`、`sa-agent-slot-<nn>` | T-PROV-24 |
| `stub-saas-api` の ingress | `INGRESS_TRAFFIC_INTERNAL_ONLY`（DEC-IAC-14 の公開集合に含めない） | `INGRESS_TRAFFIC_ALL` | T-IAC-11 / T-IAC-16 |
| Pub/Sub トピック | `agent-activity-stream` / `security-logs` / `human-permission-changed` / `human-identity-disabled` の4件 | `security-events`、`security_events` | T-SEC-08 が Terraform を持つ、T-IAC-30 は削除 |
| BigQuery の dataset | `security_audit`、テーブル保持は7日 | 30日 | T-IAC-31 が dataset、T-SEC-07 がテーブル |
| 横方向アクセスの判定 | Dedicated OP のログ項目 `op_agent_id` と、同じ行の `agent_id` の一致で判定する | リース履歴テーブル `slot_leases` | T-OP-30 が出力、T-SEC-09 と T-SEC-23 が参照 |
| 共有パッケージ（8件） | `packages/xaa-crypto`（@xaa/crypto）/ `packages/xaa-contracts`（@xaa/contracts）/ `packages/gcp`（@xaa/gcp）/ `packages/xaa-logging`（@xaa/logging）/ `packages/xaa-resource-guard`（@xaa/resource-guard）/ `packages/xaa-control-plane-auth`（@xaa/control-plane-auth）/ `packages/xaa-vertex`（@xaa/vertex）/ `packages/xaa-docs-check`（@xaa/docs-check） | `packages/control-plane-auth`、`packages/xaa-gcp`、7件固定 | T-PKG-01 が一覧を持ち、完了条件は `ls -d packages/*/ | wc -l` が 8 |
| アプリのディレクトリ名 | `apps/lifecycle-manager`（Cloud Run Service 名は `lifecycle`） | `apps/lifecycle` | T-LIFE 全体、T-PKG-29 の検査対象 |
| テストの拡張子 | `.spec.ts` | `.test.ts` | 全領域 |
| vitest の unit glob | `packages/*/test/**/*.spec.ts` と `apps/*/test/**/*.spec.ts`（`apps/*/test/integration/**` を除外） | `apps/*/test/*.spec.ts`（1階層のみ） | T-PKG-01 の `vitest.workspace.ts` |
| vitest の integration glob | `apps/*/test/integration/**/*.spec.ts` | `tests/integration/**` | T-PKG-01 |
| vitest の e2e glob | `e2e/test/**/*.spec.ts` | `e2e/tests/**`、`e2e/specs/**`、`tests/e2e/specs/**` | T-PKG-01、T-AUTHZ 前文 |
| Playwright の置き場 | `e2e/browser/**/*.spec.ts`（vitest に含めない） | `e2e/test/**` との混在 | T-PKG-01 |
| docs 検査テストの置き場 | `packages/xaa-docs-check/test/*.spec.ts` | `tests/docs/*.test.ts` | T-DOCS-01 / 03 / 04 / 10 / 12 / 13 / 14 / 15 |
| DPoP の htu の組み立て | 環境変数 `PUBLIC_BASE_URL` とリクエストパスの連結 | `Host` と `X-Forwarded-Proto` からの組み立て | T-PKG-12 が定義、T-OP-10 / T-AUTHZ-06 / T-BRIDGE-06 が従う |
| jti ストアの実装 | `packages/xaa-crypto` の `FirestoreJtiStore`（ドキュメント ID は `${namespace}__${jti}`） | インメモリ Map、アプリ別実装 | T-PKG-11 が定義、T-IDP-18 / T-AUTHZ-06 / T-BRIDGE-06 / T-OP-16 が使う |
| jti の名前空間 | `dpop` / `actor-token` / `client-assertion` の3種 | なし | T-PKG-11 |
| platform_endpoints のキー | `issuer` / `jwks_url` / `xaa_token_url` / `xaa_callback_url` / `subject_token_url` / `authorization_url` / `provisioner_url` / `lifecycle_url` / `resource_docs_as_issuer` / `resource_docs_api_url` / `resource_finance_as_issuer` / `resource_finance_api_url` / `bridge_internal_url` / `stub_saas_op_issuer` / `agent_max_lifetime_seconds` / `vertex_model` / `vertex_location` / `enable_google_bridge` の18件 | `jwks_uri`、`slots`、`resource_docs_api_resource`、`resource_finance_api_resource` | T-IAC-07 が書き、T-PKG-20 が検証、T-IAC-26 / T-RES-15 / T-LIFE-07 が読む |
| platform_endpoints のオブジェクト | `gs://<project_id>-platform-config/platform-endpoints.json` | `endpoints.json` | T-IAC-07 |
| ID-JAG の audience | Resource AS の issuer（https URL） | `urn:xaa:...` | T-OP-21 / T-RES-06 |
| Firestore データベース ID | `xaa`（名前付きデータベース） | `(default)` | T-IAC-22、全アプリ |
| deviations 表の列 | 逸脱ID / 逸脱した RULE 番号と docs 節 / 代替実装のファイルパス / テストの `パス::テスト名` の4列 | 3列目から5列目のみの検査 | T-DOCS-02 / T-DOCS-03 |

## 2. 環境変数

| 変数名 | 注入するタスク | 読むタスク | 値 |
|---|---|---|---|
| `PROJECT_ID` | T-IAC-08 | 全 Control Plane アプリ | `var.project_id` |
| `REGION` | T-IAC-08 | 全 Control Plane アプリ | `var.region` |
| `PLATFORM_ENDPOINTS_URI` | T-IAC-08 | T-PKG-24 | `gs://<project_id>-platform-config/platform-endpoints.json` |
| `STORE_MODE` | T-IAC-08 | T-PKG-24 ほか全アプリ | `gcp`（テストは `emulator`） |
| `PUBSUB_MODE` | T-IAC-08 | T-PKG-24 | `gcp`（テストは `inproc`） |
| `SIGNER_MODE` | T-IAC-08 | T-PKG-15 / T-PKG-24 | `kms`（テストは `local`） |
| `VERTEX_MODE` | T-IAC-08 | T-PKG-24 / T-APP-02 | `live`（テストは `fake`） |
| `VERTEX_MODEL` | T-IAC-39 | T-APP-01 / T-APP-02 / T-AUTHZ-01 / T-RUN-01 / T-SEC-33 | `var.vertex_model`、既定 `gemini-2.5-flash` |
| `PUBLIC_BASE_URL` | T-IAC-08 | T-OP-01 / T-AUTHZ-01 / T-PKG-12 | `local.run_url[<service>]` |
| `MODE` | T-IAC-09 | T-OP-01 | `token` または `callback` |
| `ISSUER` | T-IAC-09 | T-OP-01 / T-IDP-02 | Human IdP と Agent OP でバイト一致する1つの文字列 |
| `XAA_CLIENT_ID` | T-IAC-09 | T-OP-01 | `agent-platform` |
| `GOOGLE_CLOUD_PROJECT` | T-IAC-09 / T-IAC-12 / T-IAC-13 | T-OP-01 / T-RUN-01 | `var.project_id` |
| `FIRESTORE_DATABASE` | T-IAC-09 | T-OP-01 / T-IDP-02 | `xaa-db` |
| `JWKS_BUCKET` | T-IAC-09 / T-IAC-10 | T-OP-01 / T-IDP-02 / T-RES | JWKS 公開バケット名 |
| `JWKS_OBJECT` | T-IAC-09 | T-OP-01 | `jwks.json` |
| `KMS_IDJAG_KEY` | T-IAC-09 / T-IAC-13 | T-OP-01 | `shared-agent-op-idjag` または `dedicated-op-<short>-idjag` の完全修飾名 |
| `KMS_IDP_CONNECTION_KEY` | T-IAC-09 / T-IAC-13 | T-OP-01 | `idp-connection` 系 KMS 鍵の完全修飾名 |
| `HUMAN_IDP_AUTHORIZE_URL` | T-IAC-09 | T-OP-01 | `${local.run_url["human-idp"]}/authorize` |
| `HUMAN_IDP_TOKEN_URL` | T-IAC-09 | T-OP-01 | `${local.run_url["human-idp"]}/token` |
| `HUMAN_IDP_REVOKE_URL` | T-IAC-09 | T-OP-01 | `${local.run_url["human-idp"]}/revoke` |
| `ID_JAG_LIFETIME_SECONDS` | T-IAC-09 | T-OP-01 | 既定 300 |
| `AGENT_ID` | Shared OP には注入しない（T-IAC-09）。Dedicated OP には T-PROV-24 が注入 | T-OP-01 / T-OP-06 / T-RUN-01 | 未設定なら Shared OP として動く。設定時は `assertAgentId` を満たすこと |
| `AGENT_OP_ROLE` | 廃止 | なし | `MODE` に統一 |
| `IDJAG_KMS_KEY` | 廃止 | なし | `KMS_IDJAG_KEY` に統一 |
| `IDP_CONNECTION_KMS_KEY` | 廃止 | なし | `KMS_IDP_CONNECTION_KEY` に統一 |
| `ALLOWED_AUDIENCES` | 廃止 | なし | Agent Registration の `allowed_audiences` から実行時に引く |
| `ALLOWED_RESOURCES` | 廃止 | なし | Agent Registration の `resources` から実行時に引く |
| `JWKS_KEY_PREFIX`（Agent OP） | 廃止 | なし | kid は `AGENT_ID` から導出する |
| `ISOLATION_MODE` | 廃止 | なし | `ISOLATION_LEVEL` に統一、Agent OP には注入しない |
| `PORT` | T-IAC-09 | T-IDP-02 | Cloud Run の既定 |
| `ISSUER_PROFILE` | T-IAC-09 | T-IDP-02 | `direct` または `loadbalancer` |
| `JWKS_PUBLIC_BASE_URL` | T-IAC-09 | T-IDP-02 | JWKS バケットの公開 URL 前半 |
| `KEY_BUCKET` | T-IAC-09 | T-IDP-02 | 封筒暗号鍵を置く非公開バケット |
| `KMS_SSO_KEY_NAME` | T-IAC-09 | T-IDP-02 | SSO 署名鍵の封筒暗号用 KMS 鍵の完全修飾名 |
| `DPOP_REQUIRED` | T-IAC-09 | T-IDP-02 / T-IDP-18 | 文字列 `"true"` または `"false"`、未設定は `true` |
| `ACCESS_TOKEN_EXPIRES_IN` | T-IAC-09 | T-IDP-02 | 秒数 |
| `AUTOMATION_APP_REDIRECT_URI` | T-IAC-09 | T-IDP-02 | `${local.run_url["automation-app"]}/callback` |
| `AGENT_OP_CALLBACK_URI` | T-IAC-09 | T-IDP-02 | `${local.run_url["agent-op-callback"]}/xaa/callback` |
| `CLIENT_SECRET_AUTOMATION_APP` | T-IAC-09（Secret Manager 経由） | T-IDP-02 | Secret 参照 |
| `CLIENT_SECRET_AGENT_PLATFORM` | T-IAC-09（Secret Manager 経由） | T-IDP-02 | Secret 参照 |
| `JWKS_URI` | 廃止 | なし | `JWKS_PUBLIC_BASE_URL` に統一 |
| `SSO_KEY_WRAP_KMS_KEY` | 廃止 | なし | `KMS_SSO_KEY_NAME` に統一 |
| `AGENT_ID` | T-PROV-29（Execution override） | T-RUN-01 | 採番済みの agent_id |
| `HUMAN_SUBJECT` | T-PROV-29 | T-RUN-01 | 委譲元の human_subject |
| `TASK_ID` | T-PROV-29 | T-RUN-01 | Task 識別子 |
| `AGENT_CREATED_AT` | T-PROV-29 | T-RUN-01 | RFC 3339 |
| `AGENT_EXPIRES_AT` | T-PROV-29 | T-RUN-01 | RFC 3339 |
| `AGENT_OP_BASE_URL` | T-PROV-29 | T-RUN-01 | 共有 Agent OP または当該 Agent の Dedicated OP の URL |
| `TOOL_MANIFEST` | T-PROV-29 | T-RUN-01 | Manifest の JSON 文字列 |
| `TOOL_MANIFEST_SHA256` | T-PROV-29 | T-RUN-01 | `TOOL_MANIFEST` の SHA-256 |
| `AGENT_CLIENT_PRIVATE_JWK` | T-PROV-29 | T-RUN-01 | Agent の秘密鍵 JWK |
| `ISOLATION_LEVEL` | T-PROV-29（Execution override） | T-RUN-01 | `standard` または `full_isolation` |
| `ACTIVITY_TOPIC` | T-IAC-12 / T-IAC-13（Job の静的 env） | T-RUN-01 / T-AUTHZ-01 | `agent-activity-stream` |
| `LOG_LEVEL` | T-IAC-12 / T-IAC-13 | T-RUN-01 | `info` |
| `AGENT_CLIENT_ID` | 廃止 | なし | `PLATFORM_CLIENT_ID` 定数から取る |
| `XAA_CONFIG_JSON` | 廃止 | なし | Agent Registration から Agent OP が引く |
| `OP_TOKEN_ENDPOINT` | 廃止 | なし | `AGENT_OP_BASE_URL` から組み立てる |
| `TOOL_MANIFEST_JSON` | 廃止 | なし | `TOOL_MANIFEST` に統一 |
| `AS_KIND` | T-IAC-10 | T-RES-01 | `docs` または `finance` |
| `RESOURCE` | T-IAC-10 | T-RES-01 / T-RES-12 | Resource API の絶対 URI |
| `ALLOWED_SCOPES` | T-IAC-10 | T-RES-01 | JSON 配列 |
| `SIGNING_KEY_WRAP_KMS_KEY` | T-IAC-10 | T-RES-04 | 封筒暗号用 KMS 鍵の完全修飾名 |
| `JWKS_KEY_PREFIX`（Resource AS） | T-IAC-10 | T-RES-04 | `docs-as` または `fin-as` |
| `AS_ISSUER` | T-IAC-10 | T-RES-12 | 対応する Resource AS の issuer |
| `FIRESTORE_COLLECTION` | T-IAC-10 | T-RES-12 | `documents` または `payments` |
| `REQUIRE_ISOLATION_LEVEL` | T-IAC-10（finance のみ） | T-RES-19 | `full_isolation` |
| `FINANCE_ABSOLUTE_MAX_AMOUNT` | T-IAC-10 | T-RES-20 | 変数 `finance_absolute_max_amount`、number、既定 1000000 |
| `LIFECYCLE_SA_EMAIL` | T-IAC-10（docs と finance の両方） | T-RES-22 | `sa-lifecycle` の email |
| `BRIDGE_FACE` | T-IAC-11 | T-BRIDGE-01 | `internal` または `callback` |
| `BRIDGE_ROLE` | 廃止 | なし | `BRIDGE_FACE` に統一 |
| `BRIDGE_INTERNAL_BASE_URL` | T-IAC-11 | T-BRIDGE-01 | `local.run_url["google-bridge"]` |
| `BRIDGE_CALLBACK_BASE_URL` | T-IAC-11 | T-BRIDGE-01 | `local.run_url["google-bridge-callback"]` |
| `AUTOMATION_APP_BASE_URL` | T-IAC-11 | T-BRIDGE-01 | `local.run_url["automation-app"]` |
| `PROVISIONER_BASE_URL` | T-IAC-11 | T-BRIDGE-01 / T-LIFE-09 | `local.run_url["provisioner"]` |
| `SHARED_ISSUER` | T-IAC-11 | T-BRIDGE-01 / T-BRIDGE-05 | `ISSUER` と同一文字列 |
| `JWKS_URL` | T-IAC-11 / T-IAC-08 | T-BRIDGE-01 / T-AUTHZ-01 | `jwks.json` の公開 URL |
| `CONNECTOR_ENCRYPTION_KEY` | T-IAC-11 | T-BRIDGE-01 | connector-encryption KMS 鍵の完全修飾名 |
| `AGENT_MAX_LIFETIME_SECONDS` | T-IAC-11 / T-IAC-12 | T-BRIDGE-01 / T-RUN-01 | 変数 `agent_max_lifetime_seconds`、既定 86400 |
| `SAAS_CONNECTOR_MODE` | T-IAC-11 | T-BRIDGE-01 | `stub` または `google` |
| `CALLER_SA_RUNTIME` | T-IAC-11 | T-BRIDGE-01 / T-BRIDGE-02 | `sa-agent-runtime` の email |
| `CALLER_SA_SLOTS` | T-IAC-11 | T-BRIDGE-01 / T-BRIDGE-02 | `sa-agent-<short>` の email の CSV |
| `CALLER_SA_PROVISIONER` | T-IAC-11 | T-BRIDGE-01 | `sa-provisioner` の email |
| `CALLER_SA_LIFECYCLE` | T-IAC-11 | T-BRIDGE-01 | `sa-lifecycle` の email |
| `LIFECYCLE_MANAGER_URL` | T-IAC-08 | T-APP-01 / T-AUTHZ-01 | `local.run_url["lifecycle"]` |
| `LIFECYCLE_BASE_URL` | 廃止 | なし | `LIFECYCLE_MANAGER_URL` に統一 |
| `VERTEX_MODEL_ID` | 廃止 | なし | `VERTEX_MODEL` に統一 |
| `PLATFORM_ENDPOINTS_URL` | 廃止 | なし | `PLATFORM_ENDPOINTS_URI` に統一 |
| `APP_NAME` | T-IAC-08（共通 env に追加） | T-IAC-25 の `firestore-guard.ts` | `access-matrix.json` のキーと一致するアプリ名 |
| `ENABLE_GOOGLE_BRIDGE` | T-IAC-26（seed Job） | T-IAC-26 の `apps/seed/src/index.ts` | `true` または `false` |
| `ALLOWED_CALLER_SAS` | T-IAC-08 | T-LIFE-01 の `internal-oidc.ts` | 許可 SA email の CSV |
| `ADMIN_PRINCIPALS` | T-IAC-08（`authorization` と `provisioner` の service_specific_env） | `apps/authorization/src/config.ts` と `apps/provisioner/src/runtime.ts` | 管理コンソールを操作できる Google アカウント email の CSV。未設定は空で、だれも操作できない |
| `DPOP_IAT_SKEW_SECONDS` | T-IAC-08 | T-AUTHZ-01 | 既定 60 |
| `DPOP_JTI_TTL_SECONDS` | T-IAC-08 | T-AUTHZ-01 / T-IDP-18 | 既定 120 |

## 3. Firestore のコレクションとドキュメント

| パス | 構造 | 書く側 | 読む側 |
|---|---|---|---|
| `agents/{agent_id}` | サブドキュメントの親のみ。フィールドを持たせない | なし | なし |
| `agents/{agent_id}/meta` | Agent Registration の17キー。`agent_id` `human_subject` `client_auth` `idp_connection_id` `allowed_audiences` `resources` `scopes` `created_at` `expires_at` `status` `dedicated_op` `isolation_level` `registration_id` `kms_key_name` `job_execution_name` `bridge_binding_ids` `cleanup_step_results`。`additionalProperties: false`。`issuer` `subject` `api_base_url` `api_method` `api_path` `tool_id` を持たせない | T-PROV-19 の `registration-writer.ts`（`createRegistration` と `deleteRegistration` の2関数）と T-LIFE-02 の `status-writer.ts`（`status` と `cleanup_step_results` のみ） | T-OP-02 / T-OP-19 / T-RUN-04 / T-APP-12 / T-APP-13 / T-LIFE-03 |
| `agents/{agent_id}/state` | Agent の作業状態 | T-RUN | T-APP-12（read のみ） |
| `agents/{agent_id}/instructions` | 追加指示 | T-APP-12 | T-RUN |
| `agents/{agent_id}/manifest` | Tool Manifest の写し | T-PROV-06 | T-RUN-06 |
| `idp_connections/{idp_connection_id}` | Refresh Token の封筒暗号値と `status` と `expires_at` | T-OP-27 / T-OP-28 | T-OP-26 / T-PROV-17 / T-LIFE-06 |
| `consents/{consent_id}` | Human の同意記録 | T-IDP | T-IDP |
| `dpop_jti/{namespace}__{jti}` | `{ namespace, jti, expire_at }`。namespace は `dpop` 固定。TTL は `expire_at` | T-PKG-11 の `FirestoreJtiStore` | 同左 |
| `assertion_jti/{namespace}__{jti}` | `{ namespace, jti, expire_at }`。namespace は `actor-token` と `client-assertion`。TTL は `expire_at` | T-PKG-11 の `FirestoreJtiStore` | 同左 |
| `idjag_issuance/{issuance_id}` | ID-JAG 発行台帳 | T-OP-30 | T-SEC |
| `dedicated_resources/{agent_id}` | `agent_id` `status`（`CREATING` `READY` `FAILED` `RELEASED`）`created`（`{kind, name, created_at, deleted_at}` の配列）`created_at` `expires_at` `last_error` | 作成は T-PROV-26、削除の記録は T-LIFE-09 | T-PROV-28、T-LIFE-09、T-LIFE-10 の掃除 |
| `provisioning_transactions/{transaction_id}` | 8値の `status` と許可遷移表 | T-PROV-13 | T-PROV-16 / T-OP-25 |
| `catalog_connectors/{connector_id}` | `resource_type` `authorization_audience` `authorization_resource` `bridge_audience` `status` `risk_level` `tools` | T-IAC-26 の seed のみ | T-PROV-03 / T-BRIDGE-03 |
| `catalog_tools/{tool_id}` | `tool_id` `connector_id` `description` `required_capability` `authorization`（map、キーは `type` `audience` `resource` `scope`）`token_provider` `api`（map、キーは `base_url` `method` `path`）`parameters` `constraints` `response_schema` `risk_level` の11キーの入れ子形 | T-IAC-26 の seed のみ | T-PROV-03 / T-PROV-05 / T-AUTHZ-17 |
| `connector_definitions/{connector_id}` | Bridge が読む接続先の12キー（`connector_id` `display_name` `authorization_endpoint` `token_endpoint` `revocation_endpoint` `userinfo_endpoint` `client_id` `secret_name` `default_scopes` `subject_claim` `connection_max_age_seconds` `resource_uris`）。`client_secret` を持たず `secret_name` で Secret Manager を指す。`enable_google_bridge=true` のときだけ行があり、`saas_connector_mode` に応じて `stub-saas-calendar` か `google-workspace` の1件 | T-IAC-26 の seed のみ | T-BRIDGE-02 |
| `capability_taxonomy/{capability_id}` | `resource` `object` `action` `description` `default_characteristics` | T-IAC-26 の seed のみ | T-AUTHZ |
| `human_permissions/{human_subject}__{capability_id}` | `human_subject` `capability_id` `granted_at` の1行1ドキュメント | T-IAC-26 の seed | T-PROV-12 が `where('human_subject','==',humanSubject)` で引く、T-AUTHZ-03 |
| `delegatable_permissions/{capability_id}` | 委譲可能 Capability | T-IAC-26 の seed | T-AUTHZ |
| `organization_policies/{policy_id}` | 組織ポリシー | T-IAC-26 の seed | T-AUTHZ |
| `risk_policies/{policy_id}` | リスクポリシー | T-IAC-26 の seed | T-AUTHZ-18 |
| `ai_proposals/{proposal_id}` | AI 提案 | T-AUTHZ | T-AUTHZ |
| `authorization_decisions/{decision_id}` | 認可決定 | T-AUTHZ | T-AUTHZ / T-APP |
| `policy_decisions/{decision_id}` | Policy Engine の決定 | T-AUTHZ | T-AUTHZ |
| `sessions/{session_id}` | Automation App のセッション | T-APP-12 | T-APP-12 |
| `work_definitions/{id}` | 業務定義 | T-APP-12 | T-APP-12 |
| `agent_definitions/{id}` | Agent 定義 | T-APP-12 | T-APP-12 / T-PROV |
| `bridge_connections/{connection_id}` | 外部 SaaS の接続 | T-BRIDGE-04 | T-BRIDGE-04 |
| `agent_bindings/{binding_id}` | `binding_id` `agent_id` `connector_id` `connection_id` `human_subject` `scopes` `status`（`ACTIVE` と `DISABLED`）`created_at` `expires_at` | T-BRIDGE-04 | T-BRIDGE-07 / T-BRIDGE-08 |
| `bridge_consent_states/{state}` | `transaction_id` `connector_id` `human_subject` `required_scopes` `code_verifier` `created_at` `expire_at` | T-BRIDGE-11 | T-BRIDGE-11 |
| `bridge_consent_codes/{code}` | 一時コード。`expire_at` を持つ | T-BRIDGE-11 | T-BRIDGE-11 |
| `documents/{document_id}` | Document Resource の本体 | T-RES-12 | T-RES-12 |
| `payments/{payment_id}` | Finance Resource の本体 | T-RES-12 | T-RES-12 |
| `users/{sub}/activity/{event_id}` | Activity Event。`expire_at` の TTL は7日 | T-APP-23 | T-APP-22 |
| `xaa_configs` | 作らない | なし | `agents/{agent_id}/meta` の3フィールドを `toXaaConfig(registration)` で射影する |
| `issuer_profiles` | 作らない | なし | issuer は環境変数 `ISSUER`、kid は `AGENT_ID` から導出する |
| `agent_registrations` | 作らない | なし | `agents/{agent_id}/meta` に統一 |
| `connector_bindings` | 作らない | なし | `agent_bindings` に統一 |
| `jti_locks` | 作らない | なし | `dpop_jti` と `assertion_jti` に統一（DEC-IAC-22） |
| `bridge_dpop_jti` | 作らない | なし | `dpop_jti` の名前空間 `dpop` に統一 |
| `isolation_slots` | 作らない | なし | `dedicated_resources` に統一 |

## 4. HTTP エンドポイント

| パス | 提供するタスク | 呼ぶタスク | 認証 |
|---|---|---|---|
| `POST /xaa/token` | T-OP-01（`MODE=token`） | T-RUN-11 | `client_assertion_jwt`（`typ=agent-client-auth+jwt`）と DPoP Proof |
| `POST /xaa/subject-token` | T-OP-01（`MODE=token`） | T-RUN-11 | 同上 |
| `POST /internal/idp-connections` | T-OP-01（`MODE=token`） | T-PROV-23 | Google 発行 OIDC ID Token の `email` を `sa-provisioner` と `sa-lifecycle` の許可リストと照合 |
| `POST /internal/idp-connections/{idp_connection_id}/verify` | T-OP-01 | T-PROV-17 | 同上 |
| `POST /internal/idp-connections/{idp_connection_id}/revoke` | T-OP-01 / T-OP-28 | T-LIFE-06 | 同上 |
| `POST /internal/agents/{agent_id}/disable-issuance` | T-OP-01 | T-LIFE-05 | 同上 |
| `POST /internal/agents/{agent_id}/credentials/revoke` | T-OP-01 | T-LIFE-08 | 同上 |
| `POST /internal/agents/{agent_id}/delete` | T-OP-01 | T-LIFE-08 | 同上 |
| `GET /xaa/callback` | T-OP-01（`MODE=callback`）/ T-OP-25 | ブラウザ | `state` と one_time_code |
| `GET /livez` | T-OP-01 ほか全アプリ | 監視 | 無認証。`/healthz` は Google Frontend が横取りしてコンテナへ届かないため使わない（`infra/spike/RESULT.md` (c)） |
| `POST /internal/revoke-connection` | 提供しない | なし | `POST /internal/idp-connections/{idp_connection_id}/revoke` に統一 |
| `/authorize` `/token` `/userinfo` `/logout` `/revoke` `/.well-known/openid-configuration` | T-IDP-01 | T-APP / T-OP-19 / ブラウザ | OIDC 標準 |
| `POST /provisioning` | T-PROV-16 | T-APP-14 | Control Plane の `at+jwt` と DPoP、scope `agent:provision` |
| `POST /provisioning/{transaction_id}/resume` | T-PROV-14 | T-OP-25 | 同上 |
| （スロット返却 API は作らない） | なし | なし | 削除は T-LIFE-09 が GCP API を直接呼ぶ |
| `POST /internal/provisioning/reprovision` | T-PROV-16 | T-LIFE-13 の (3) | 同上、呼び出し元は `sa-lifecycle` |
| `POST /agents/{agent_id}/revoke` | T-LIFE-01 / T-LIFE-11 | T-APP-14（`{LIFECYCLE_MANAGER_URL}/agents/{agent_id}/revoke`） | Control Plane の `at+jwt` と DPoP |
| `POST /internal/tick` | T-LIFE-01 | Cloud Scheduler（T-IAC-27） | Google 発行 OIDC ID Token、`sa-scheduler` |
| `POST /internal/agents/{agent_id}/transition` | T-LIFE-01 / T-LIFE-12 | T-SEC-34（body は `{ from, to, finding_id, reason_code, severity? }`） | Google 発行 OIDC ID Token、`ALLOWED_CALLER_SAS` |
| `POST /internal/agents/{agent_id}/reprovision` | T-LIFE-01 / T-LIFE-13 | T-AUTHZ-28（`{LIFECYCLE_MANAGER_URL}/internal/agents/{agent_id}/reprovision`） | 同上、`sa-authorization` |
| `POST /sweep` | 提供しない | なし | `POST /internal/tick` に統一 |
| `POST /internal/security/transition` | 提供しない | なし | `POST /internal/agents/{agent_id}/transition` に統一 |
| `POST /token`（Bridge internal） | T-BRIDGE-01 / T-BRIDGE-05 | T-RUN-14 | ID-JAG の jwt-bearer と DPoP |
| `POST /connections/check` | T-BRIDGE-01 / T-BRIDGE-13 | T-PROV-16 | Google 発行 OIDC ID Token、`CALLER_SA_PROVISIONER` |
| `POST /connections/verify` | T-BRIDGE-01 | T-PROV-17 | 同上 |
| `POST /connections/{connection_id}/revoke-upstream` | T-BRIDGE-01（internal 8ルート目） | T-LIFE-07 の step5 (c) | Google 発行 OIDC ID Token、`CALLER_SA_LIFECYCLE` |
| `POST /bindings` | T-BRIDGE-01 | T-PROV | 同上 |
| `POST /bindings/{agent_id}/disable` | T-BRIDGE-01 / T-BRIDGE-08 | T-LIFE-07 の step4（宛先は `platform_endpoints.bridge_internal_url`） | 同上 |
| `DELETE /bindings/{agent_id}` | T-BRIDGE-01 | T-LIFE-08 の step11 | 同上 |
| `POST /internal/agent-bindings/{binding_id}/disable` | 提供しない | なし | `POST /bindings/{agent_id}/disable` に統一、粒度は agent_id 単位 |
| `GET /{connector_id}/oauth/start` と `GET /{connector_id}/oauth/callback` | T-BRIDGE-01（`BRIDGE_FACE=callback`） | ブラウザ | `state` と PKCE |
| `POST /v1/authorization/decisions` | T-AUTHZ-01 | T-APP / T-PROV | `controlPlaneAuth`、audience `authorization-platform` |
| `POST /api/work-requests` | T-AUTHZ-01 | T-APP | 同上 |
| `POST /internal/events/human-permission-changed` | T-AUTHZ-01 / T-AUTHZ-27 | Pub/Sub push（T-IAC-29 の `push_endpoint` を `${local.run_url["authorization"]}/internal/events/human-permission-changed` にする） | `sa-pubsub-push` の OIDC と run.invoker |
| `POST /internal/permission-changed` | 提供しない | なし | 上の1本に統一 |
| `POST /internal/activity/push` | T-APP-23 | Pub/Sub push（T-IAC-28 の `push_endpoint` を `${local.run_url["automation-app"]}/internal/activity/push` にする） | `sa-pubsub-push` の OIDC と run.invoker |
| `POST /internal/activity` | 提供しない | なし | `POST /internal/activity/push` に統一 |
| `GET /api/activity/tasks` と `GET /api/activity/tasks/{task_id}` | T-APP-22 | ブラウザ | ログイン済みセッション |
| `POST /api/agents/{agent_id}/instructions` と `POST /api/agents/{agent_id}/stop` | T-APP-14 / T-APP-15 | ブラウザ | 同上 |
| `POST /internal/revoke-by-actor` | T-RES-22（docs と finance の両方） | T-LIFE-07 の step5 (a) | Google 発行 OIDC ID Token、`LIFECYCLE_SA_EMAIL` と照合 |
| `GET /documents` `GET /documents/{id}` `POST /documents` | T-RES-12 | T-RUN の Tool Executor | DPoP バウンドの Access Token |
| `GET /payments` `GET /payments/{id}` `POST /payments/{id}/approve` | T-RES-12 | 同上 | 同上、加えて `REQUIRE_ISOLATION_LEVEL=full_isolation` |
| `POST /internal/log` | 提供しない | なし | `security-logs` は pull にする（DEC-SEC-03） |

## 5. 成果物の唯一の所有者

実装の過程でファイルを統合または改名し、タスクが「成果物」欄に書いたパスが無くなった場合は、
`tasks/artifact-map.json` にタスクID単位で「宣言したパス」と「その挙動を実際に持つファイル」を書く。
`pnpm check:done` はこの表を使ってパスの不在を解決する。
挙動そのものが無い場合はここへ書かず、実装する。
宣言したパスが再び存在するようになった項目と、所有ファイルが消えた項目は stale として検査で落ちる。

完了条件の印は3種類で、`pnpm check:done` はこの3種類だけを読む。

| 印 | 意味 | 検査 |
|---|---|---|
| `- [x]` | リポジトリ内で条件が成り立つことを、条件に書いたコマンドかテストで確認した | 数えない |
| `- [ ]` | 未確認。実装が無いか、確認していない | 1件でもあれば非 0 で終了する |
| `- [~]` | live の GCP プロジェクト、`gcloud`、Docker daemon、実 Vertex AI のいずれかが無いと観測できない。行内に、デプロイ後にそれを観測する `infra/tests/` か `scripts/` か `.github/workflows/` 配下のファイル、または `Makefile` をバッククォートで1つ以上書く | 観測スクリプトが無い、または実在しない行があれば非 0 で終了する |

`- [~]` は「確認済み」ではない。`scripts/deploy-gcp-guide.sh verify` が `infra/tests/verify-all.sh` を実行した時点で、行に書いたスクリプトが観測する。


| ファイルパス | 所有タスク | 他タスクは何をするか |
|---|---|---|
| `Dockerfile` と `.dockerignore` | T-PKG-26 | T-IAC-34 は成果物から外し、Artifact Registry と shared の outputs のみを作る |
| `Makefile` | T-PKG-26 | T-IAC-46 は `# --- infra targets (T-IAC) ---` の下に `bootstrap` `shared-apply` `demo-apply` `seed` `verify` `demo-destroy` `all` の7ターゲットを追記する。`images` は T-PKG-26 の定義を使う |
| `scripts/build-images.sh` | T-PKG-26 | T-IAC-34 の `scripts/build-push.sh` は作らない。T-IAC-34 の完了条件は `make image-human-idp IMAGE_TAG=v1` に、T-IAC-46 の grep 対象は `Makefile scripts/build-images.sh` にする |
| `infra/tests/no-kms-key-version.sh` と `infra/tests/runtime-mutation-scope.sh` と `infra/tests/no-firestore-sdk-in-frontend.sh` と `infra/tests/run-static-checks.sh` | T-PKG-29 | T-IAC-43 / T-IAC-44 / T-PROV-24 / T-LIFE-09 は成果物から外し、検査対象ディレクトリと禁止シンボルに自領域分を追記する |
| `docs/deviations.md` | T-DOCS-02 | T-PKG-30 は削除する |
| `scripts/check-deviations.ts` | T-DOCS-03 | `scripts/check-deviations.mjs` は作らない。T-PKG-27 の CI ジョブ一覧から `docs:deviations` を外し、T-DOCS-16 の `.github/workflows/docs.yml` に一本化する |
| `packages/xaa-contracts/src/audience.ts` | T-PKG-17 | T-IDP-11 と T-AUTHZ-05 は成果物から外し、`audienceIncludes(aud, self)` を import する。T-IDP-11 の前提タスクに T-PKG-17 を足す |
| `packages/xaa-contracts/src/actor-token.ts` | T-PKG-18 | T-OP-13 と T-RUN-09 は成果物から外し、`toAgentUrn` と `AGENT_URN_PREFIX` と `ACTOR_TOKEN_TYP` を import する |
| `packages/xaa-contracts/src/agent-namespace.ts` | T-PKG-18 | T-OP-18 は `isAgentId` を削除し、import して呼ぶ |
| `packages/xaa-contracts/src/protocol-violation.ts` | T-SEC-11 | T-AUTHZ-07 と T-RUN-25 は成果物から外し、`emitProtocolValidation(logger, ctx, ev)` を import する。T-OP-11 と T-BRIDGE-02 の呼び出しも3引数形にする |
| `packages/xaa-contracts/src/identifiers.ts` の `assertValidCapabilityId` | T-PKG-16 | T-AUTHZ-03 は `apps/authorization/src/seed/validate-naming.ts` を作らず import する。T-IAC-27 と T-RES-15 も import する |
| `packages/xaa-contracts/src/token-catalog.ts` | T-PKG-16 | T-DOCS-15 は完了条件の参照先をこのファイルにする |
| `packages/xaa-contracts/src/service-ids.ts` と httpClient | T-PKG-21 | 各アプリは `SERVICE_IDS` を import する。Dedicated OP 宛は `dedicated_resources` の台帳が持つ URL へ `requestUrl(url, path, init?)` で送る |
| `packages/xaa-contracts/src/runtime-env.ts` | T-RUN-01 | T-PROV-29 は `RUNTIME_ENV_KEYS` を import し、override の11件だけを渡す |
| `packages/xaa-contracts/src/collections.ts` | T-IAC-24 | 他タスクはコレクション名の文字列を直書きしない |
| `packages/gcp/src/access-matrix.json` と `packages/gcp/src/firestore-guard.ts` | T-IAC-25 | T-APP-12 / T-OP-02 / T-RES-02 / T-RUN-04 / T-LIFE-01 / T-BRIDGE-04 / T-AUTHZ-23 は成果物から外し、自アプリの許可パスを実装方針に列挙するだけにする |
| `packages/gcp/src/firestore-json-store.ts` | T-PKG-25 | T-RES-02 は成果物から外し、`createFirestoreJsonStoreBackend(options)` を collection 名を変えて4アプリから呼ぶ |
| `packages/xaa-crypto` の `FirestoreJtiStore` | T-PKG-11 | T-IDP-18 / T-AUTHZ-06 / T-BRIDGE-06 / T-OP-16 は独自ストアを作らず、名前空間を渡して使う |
| `packages/xaa-crypto/README.md` | T-PKG-10 | REQ-05-017 の4機能と担当タスク T-PKG-04 / T-PKG-09 / T-PKG-10 / T-PKG-05 の対応表を4行で書く |
| `apps/seed/src/index.ts` と `apps/seed/src/resolve.ts` と `infra/seed/**` | T-IAC-26 | T-PROV-02 を削除し、YAML の中身と命名規約検査を T-IAC-26 と T-IAC-27 へ吸収する。T-PROV-03 の前提を T-IAC-26 に付け替え、Catalog Repository は読み取り専用のまま残す。T-PROV-01 は定数表と2つの JSON Schema だけを持つ |
| `infra/seed/connectors/stub-saas-calendar.yaml` | T-IAC-26 | `infra/seed/connectors/google-workspace.yaml` は作らない |
| `assertRuntimeName` と実行時作成の名前規約（`dedicated-names.ts`） | T-PROV-24 | T-LIFE-09 は同じ関数を `packages/xaa-contracts` 経由で import して使い、自前で名前を組み立てない |
| `infra/envs/shared/audit.tf` | T-IAC-31 | T-SEC-07 は `infra/envs/shared/audit-tables.tf` と `schemas/*.json` と `infra/tests/audit-iam.test.ts` に縮め、保持は7日、SA は `sa-security`、テーブル単位の binding のみにする |
| `infra/envs/demo/security-events.tf` | T-SEC-08 | T-IAC-30 を削除し、トピック定義と Log Sink と IAM を T-SEC-08 へ吸収する。トピック名は `security-logs` のまま、`human-identity-disabled` トピックと pull subscription `identity-disabled-to-lifecycle` を追加し、T-LIFE-15 の前提に T-SEC-08 を足す |
| `scripts/check-readme-vars.sh` | T-IAC-47 | 成果物に追加し、`infra/envs/*/variables*.tf` と `infra/README.md` の変数集合の差を検査する |
| `apps/human-idp/src/config/dpop-required-audiences.ts` | T-IDP-18 | `authorization-platform` / `agent-provisioner` / `lifecycle-manager` の3値をここだけに置き、T-IDP-11 の `SCOPE_TO_AUDIENCE` の値域と起動時に突き合わせる |
| `vitest.workspace.ts` | T-PKG-01 | 他領域は成果物パスをこの glob に合わせるだけにする |
| `packages/xaa-docs-check/**` | T-DOCS-01 | T-DOCS-03 / 04 / 10 / 12 / 13 / 14 / 15 は成果物とコマンドをこのパスへ寄せる |
| `.github/workflows/ci.yml` | T-PKG-27 | T-PKG-30 は削除する |
| `.github/workflows/docs.yml` | T-DOCS-16 | `docs:refs` と `docs:deviations` と `docs:traceability` をここに集約する |
| `packages/xaa-control-plane-auth/**` | T-AUTHZ-05 | T-IDP-12 は `packages/xaa-contracts/src/scope-guard.ts` と `token-types.ts` を作らず、`packages/xaa-control-plane-auth/test/scope-contract.spec.ts` の契約テストだけを持つ |
| `apps/agent-op/src/idjag/sign-id-jag.ts` と `apps/agent-op/test/signing-typ.spec.ts` と `scripts/check-single-asymmetric-sign.sh` | T-OP-07 | 成果物欄の自己訂正表記を消し、この3件だけにする |
| `infra/bootstrap/main.tf` と `variables.tf` と `outputs.tf` と `infra/envs/shared/backend.tf` と `infra/envs/demo/backend.tf` と `infra/envs/demo/remote-state.tf` | T-IAC-02 | 成果物欄はこの6件だけにし、「shared に remote-state.tf を置かない」は実装方針へ移す |

## 6. タスク参照の訂正表

| 誤った参照 | 正しい参照 |
|---|---|
| T-INFRA-07（T-OP-04 と T-OP-05 の前提） | T-IAC-20 |
| T-INFRA-09（T-OP-06 の前提） | T-IAC-18 |
| T-INFRA-05（T-OP-24 の前提） | T-IAC-18 |
| T-BASE-04（T-OP-07 の前提） | T-PKG-14 |
| T-BASE-03（T-OP-10 の前提） | T-PKG-12 |
| `# --- infra targets (T-INFRA) ---`（T-PKG-26 の Makefile 見出し） | `# --- infra targets (T-IAC) ---` |
| T-SEC-02（T-OP-11 / T-OP-17 / T-OP-20 / T-OP-29 の前提） | T-SEC-11 |
| T-PROV-03 と T-IDP-04（T-OP-25 の前提） | T-OP-24, T-OP-01, T-PROV-13, T-IDP-13 |
| T-IDP-05（T-OP-28 の前提） | T-OP-27, T-IDP-15, T-LIFE-08 |
| T-OP-10（T-PKG 末尾表の REQ-05-072 と REQ-07-016） | T-OP-19（expires_at と status 判定、Identity 層の期限強制） |
| T-OP-20（T-PKG 末尾表の REQ-05-078 と REQ-07-017） | T-OP-23（exp の cap 計算、Authorization 層の期限強制） |
| T-AUTHZ-06（T-IAC-27 と T-RES-15 と T-RES 末尾表の命名規約と Capability Taxonomy 登録） | T-AUTHZ-03（規約の起票元）と T-PKG-16（`assertValidCapabilityId` の実装） |
| T-AUTHZ-09（T-RES-18 と T-RES 末尾表の Risk Policy） | T-AUTHZ-18 |
| T-RUN-10（T-RES 末尾表の `max_amount` 事前検証） | T-RUN-16 |
| T-RUN-14（T-RES 末尾表の Google API 呼び出しの代替ログ） | T-RUN-24 |
| T-LIFE-04（T-RES 末尾表と T-BRIDGE-18 の `/internal/revoke-by-actor` と disable の呼び出し元） | T-LIFE-07（step4 と step5）と T-LIFE-08（step11 の DELETE） |
| T-SEC-07（T-RES-10 の静的検査対象） | T-SEC-01 |
| T-AUTHZ-14（T-LIFE-13 の前提、Re-Provisioning の依頼元） | T-AUTHZ-28 |
| T-TEST-01（T-LIFE-17 の前提） | 削除し、前提は T-LIFE-10 と T-LIFE-16 だけにする |
| T-TEST-03 / T-TEST-04 / T-TEST-06 / T-TEST-10 / T-TEST-14（T-RUN 末尾表） | 表ごと削除し、第7節の引き取り先へ差し替える |
| `apps/lifecycle/src`（T-PKG-29 の検査対象） | `apps/lifecycle-manager/src` |
| `packages/control-plane-auth`（T-AUTHZ-05 の成果物） | `packages/xaa-control-plane-auth` |
| T-DOCS 末尾表の REQ-02-014 と REQ-05-017 の行 | 削除し、T-IDP-18 と T-PKG-10 が対象要件として持つ |
| T-IAC 末尾表の REQ-03-019 の行 | 削除し、T-AUTHZ-03 が対象要件として持つ |

## 7. 引き取り先が無かった要件

| 要件ID | 引き取るタスク | 追記する内容 |
|---|---|---|
| REQ-01-023 | T-RUN-27（新規） | Native XAA 経路4ステップの E2E。成果物は `e2e/test/runtime/native-xaa-path.spec.ts`。前提は T-RUN-12, T-RUN-17, T-RES-23, T-OP-12。agent-op / human-idp / resource-docs-as / resource-docs-api / agent-runtime の `createApp()` を1プロセスで結線し、`JWT_BEARER_GRANT_TYPE` 定数を使い、ID-JAG は `/xaa/token` から実際に取得する。完了条件は `pnpm test:e2e -- runtime/native-xaa-path` が緑であることと、`globalThis.fetch` のスタブが0回呼ばれること |
| REQ-05-093 | T-RUN-28（新規） | Native XAA Runtime Flow 10手順を Document と Finance で1本ずつ通す。成果物は `e2e/test/runtime/runtime-flow-docs.spec.ts` と `e2e/test/runtime/runtime-flow-finance.spec.ts`。前提は T-RUN-27, T-RUN-18, T-RES-19, T-RES-21。Finance 側は `isolation_level=full_isolation` で Provision する。各シナリオで ID-JAG の `sub` / `act.sub` / `aud` / `cnf.jkt` と Access Token の `cnf` / `act` の計6件をアサートする |
| REQ-04-025 | T-RUN-29（新規） | プロンプトインジェクション拒否の E2E。成果物は `e2e/test/runtime/prompt-injection.spec.ts`。前提は T-RUN-07, T-RUN-18, T-RUN-27。Manifest を `internal.document.list` と `internal.document.get` に限り、Document の `body` へ `internal.finance.payment.approve` を促す文言を `POST /documents` で投入する。Tool Executor の戻り値が `{ outcome: 'blocked', reason: 'not_in_allowed_tools', error_code: 'tool_not_allowed' }` であることと、Agent OP と finance 系2サービスへの呼び出しが0回であることを確認する |
| REQ-11-030 | T-RUN-30（新規） | デモ D-1 を実操作 E2E で通す。成果物は `e2e/test/demo/out-of-permission.spec.ts`。前提は T-RUN-23, T-RUN-25, T-RUN-26, T-APP-15, T-APP-31。追加指示は `POST /api/agents/{agent_id}/instructions` から入れ、Firestore へ直接書かない。`TOOL_BLOCKED` と `TASK_BLOCKED` が1件ずつ記録され、再生で `data-blocked="true"` が1個、宛先ノードの `data-reached` が `"false"` であることを確認する。D-2 は T-AUTHZ-31、D-3 は T-LIFE-17、D-4 は T-AUTHZ-32 が持つ |
| REQ-06-022 | T-BRIDGE-20（既存） | 「対象要件」を `REQ-01-024, REQ-06-018` から `REQ-01-024, REQ-06-018, REQ-06-022` へ変更する。完了条件へ「(7) で提示した ID-JAG の `sub` が `human_subject` と、`act.sub` が `urn:xaa:agent:<agent_id>` と、`cnf.jkt` が Execution の DPoP 鍵の RFC 7638 thumbprint と一致することを3件ともアサートしている」を追加する。新規タスクを作らない |
| REQ-02-014 | T-IDP-18（既存） | 「対象要件」を `REQ-05-018` から `REQ-05-018, REQ-02-014` へ変更する。DPoP ヘッダの必須判定を audience 単位にし、`audienceIncludes` で `authorization-platform` / `agent-provisioner` / `lifecycle-manager` のいずれかに一致する場合は必須、無い場合と検証失敗は 400 と `{"error":"invalid_dpop_proof"}` を返す。判定表は `apps/human-idp/src/config/dpop-required-audiences.ts` に1か所だけ置く。`DPOP_REQUIRED` はこの3 audience 以外への上乗せフラグとして残す。完了条件へ audience ありで 400、`scope=openid` のみで 200 かつ `token_type` が `Bearer` の2行を追加する |
| REQ-05-017 | T-PKG-10（既存） | 「対象要件」を `REQ-05-074, REQ-09-026, REQ-05-070` から `REQ-05-017, REQ-05-074, REQ-09-026, REQ-05-070` へ変更する。4機能の分担（鍵ペア生成は T-PKG-04、Proof 生成は T-PKG-09、Proof 検証は T-PKG-10、Thumbprint は T-PKG-05）を `packages/xaa-crypto/README.md` に4行の表で書く。完了条件へ `dpop.spec.ts::rejects htm mismatch` と README の対応表の2行を追加する |
| REQ-03-019 | T-AUTHZ-03（既存） | 「対象要件」を `REQ-03-010` から `REQ-03-010, REQ-03-019` へ変更する。命名規約の検査は `assertValidCapabilityId` を import して全行に対して呼び、違反が1件でもあれば全違反行を標準エラーへ出して `process.exit(1)` する。完了条件へ「違反時の標準エラー出力に、違反した `capability_id` の文字列そのものが1件につき1行含まれる」を追加する。前提タスクに T-PKG-16 を足す |
| REQ-08-044 | T-DOCS-17（新規） | `docs/08-gcp-infrastructure.md` の当該記述を「Resource AS の `/token` は RFC 6749 §5.2 に従い 400 と `invalid_request` / `invalid_grant` を返す。401 と `WWW-Authenticate` を返すのは Resource API 側である」へ書き換える。完了条件は `grep -n '401' docs/08-gcp-infrastructure.md` のヒットが Resource API の節に限られること。T-RES-06 の「docs 領域へ起票する」を「T-DOCS-17 が訂正する」へ差し替える |
