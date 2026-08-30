# 03. Human IdP（T-IDP）

Human IdP は、この基盤で人間ユーザーを認証する唯一の OpenID Provider である。
Automation App へのログイン用 ID Token、Control Plane 3アプリ向けの Access Token、Cross App Access の `subject_token` になる ID Token と Refresh Token を発行する。
実装は maronn-openid-connect の CLI が生成した Hono アプリを基礎とし、生成物へ最小の手編集を加えて audience 分離、scope 登録、offline_access の同意判定、DPoP 束縛、構造化ログを足す。
Agent の識別子、Agent ごとのクライアント登録、Agent 向けポリシーはこのアプリに一切持ち込まない。
ID-JAG を発行するのは Agent OP であり、Human IdP の `/token` は Token Exchange を受け付けない。

| 前提 | 内容 |
|---|---|
| 依存する領域 | 共通パッケージ（`packages/xaa-crypto` の DPoP と `packages/xaa-contracts` の定数表）、IaC（Cloud Run / KMS / GCS / Firestore / Secret Manager の作成と env 注入）、Agent OP（`/xaa/callback` と Refresh Token 保持）、Automation App（`/callback` とログイン） |
| このファイルのタスク数 | 19件 |
| 主に満たす設計ルール | RULE-06, RULE-38, RULE-45, RULE-47, RULE-50, RULE-51, RULE-53 |

---

### T-IDP-01 Human IdP を CLI から生成してリポジトリへ取り込む

**概要**
`maronn-oidc generate hono` の生成物を `apps/human-idp/src/oidc/` へコミットし、以降のタスクが手編集する土台を作る。
無改変の複製を `generated-baseline/human-idp/` に置き、CI が固定バージョンの CLI で再生成して差分を検出できるようにする。
DEC-ID-01（生成物をそのまま使う4系統の1つ）と DEC-APP-04（生成物のコミットと差分検出）に対応する。

**対象要件** REQ-05-001, REQ-08-019
**前提タスク** なし
**成果物**
- `apps/human-idp/package.json`
- `apps/human-idp/src/oidc/`（`app.ts` `apply.ts` `config.ts` `store.ts` `resolvers.ts` `views.ts` `routes/{authorize,token,userinfo,introspection,revocation,jwks,discovery,login,consent}.ts` `conformance.test.ts`）
- `generated-baseline/human-idp/`（同内容の無改変コピー）
- `apps/human-idp/src/app.ts`（`createApp(): Hono` を default export）
- `apps/human-idp/src/index.ts`（`@hono/node-server` の起動エントリ）
- `scripts/regenerate-oidc.sh`
- `.github/workflows/ci.yml` へジョブ `oidc:baseline` を追加

**実装方針**
- 生成コマンドは `pnpm dlx @maronn-openid-connect/cli@0.4.0 generate hono --output apps/human-idp/src/oidc` に固定する。
- `--enable` を付けない。有効な feature は既定の pkce, refresh-token, introspection, revocation, request-object の5つだけになる。
- `--enable id-jag` と `--enable token-exchange` を付けない。付けると `/token` が Token Exchange を受理し RULE-47 に反する。
- `@maronn-openid-connect/core` と `@maronn-openid-connect/cli` の依存は `0.4.0` の exact 指定にする（caret も tilde も付けない）。
- `apps/human-idp/src/app.ts` は `createApp()` の中で Hono を生成し、生成物の `applyOidc(app, options)` を呼ぶ形にする。統合テストが `app.fetch(request)` を直接呼べるようにするためで、`createApp` の中で `serve()` を呼ばない（DEC-APP-07）。
- `apps/human-idp/src/index.ts` だけが `serve({ fetch: createApp().fetch, port: Number(process.env.PORT ?? 8080) })` を呼ぶ。
- 生成物への手編集は `// XAA-PATCH:<REQ-ID> begin` と `// XAA-PATCH:<REQ-ID> end` で必ず囲む。本タスクの時点では手編集を1行も入れない。
- コンテナはリポジトリ直下の単一 Dockerfile を `--build-arg APP=human-idp` で使う。`apps/human-idp/Dockerfile` を作らない（DEC-APP-02）。

**完了条件**
- [ ] `scripts/regenerate-oidc.sh` を実行すると `generated-baseline/human-idp/` と `git diff --exit-code` が差分なしで終了する
- [ ] `apps/human-idp/src/oidc/` に `routes/par.ts` `routes/device.ts` `routes/jarm.ts` が存在しない
- [ ] `pnpm --filter human-idp test` が生成物の `conformance.test.ts` を含めて緑になる
- [ ] `grep -rn "XAA-PATCH" apps/human-idp/src/oidc/` が 0 件を返す

---

### T-IDP-02 環境変数の契約を確定してデプロイ設定を固定する

**概要**
Human IdP が読む環境変数を1ファイルに集約し、起動時に Ajv で検証して欠落を落とす。
Terraform が注入する値と、アプリが期待する値のズレを apply 前に見つけられるよう、機械可読なスキーマをリポジトリに置く。
制約1（GCP の設定を IaC で管理できること）を優先し、アプリ側に既定値を隠さない方針に対応する。

**対象要件** REQ-08-019
**前提タスク** T-IDP-01
**成果物**
- `apps/human-idp/src/env.ts`
- `apps/human-idp/env.schema.json`
- `apps/human-idp/test/env.spec.ts`

**実装方針**
- 環境変数は次の16個に固定する。`PORT` / `ISSUER` / `ISSUER_PROFILE` / `JWKS_BUCKET` / `JWKS_PUBLIC_BASE_URL` / `KEY_BUCKET` / `KMS_SSO_KEY_NAME` / `SIGNER_MODE` / `STORE_MODE` / `FIRESTORE_DATABASE` / `DPOP_REQUIRED` / `CLIENT_SECRET_AUTOMATION_APP` / `CLIENT_SECRET_AGENT_PLATFORM` / `AUTOMATION_APP_REDIRECT_URI` / `AGENT_OP_CALLBACK_URI` / `ACCESS_TOKEN_EXPIRES_IN`。
- `ISSUER_PROFILE` の許可値は `direct` と `loadbalancer` の2つだけにする（DEC-ID-04）。
- `SIGNER_MODE` は `local` と `kms`、`STORE_MODE` は `emulator` と `gcp` を許可値にする（DEC-APP-09）。
- `DPOP_REQUIRED` は文字列 `"true"` / `"false"` として受け取り、未設定時は `true` として解釈する。
- `env.schema.json` は JSON Schema（`additionalProperties: false`）で書き、TypeScript 型は `json-schema-to-ts` で導出する（DEC-APP-05）。
- 検証失敗時は `process.exit(1)` ではなく `loadEnv()` から `EnvValidationError` を throw し、`index.ts` が捕まえて stderr へ欠落キー名を出してから終了する。値そのものは出力しない。
- クライアントシークレット2件は Secret Manager から Cloud Run の env として渡される前提とし、アプリからは Secret Manager API を呼ばない。

**完了条件**
- [ ] `apps/human-idp/test/env.spec.ts` の `rejects missing ISSUER` と `rejects ISSUER_PROFILE=lb` が緑になる
- [ ] `CLIENT_SECRET_AGENT_PLATFORM` を空にして起動すると exit code が 1 になり、stderr にキー名だけが出てシークレット値が出ない
- [ ] `apps/human-idp/env.schema.json` の `required` 配列が16件で、`env.ts` が参照する変数名と完全一致する

---

### T-IDP-03 署名鍵の自己ブートストラップと JWKS オブジェクト公開を実装する

**概要**
Human IdP の署名鍵を、起動時に「無ければ作る、あれば復号して読む」形で用意する。
鍵素材は KMS の ENCRYPT_DECRYPT 鍵で封筒暗号して非公開バケットへ置き、公開 JWK だけを JWKS バケットの自分専用オブジェクトへ書く。
DEC-ID-17（core の SigningKeyProvider が CryptoKey を要求するため KMS 署名にできない）と RULE-53（各アプリは自分の鍵だけを書く）に対応する。

**対象要件** REQ-05-001, REQ-08-018
**前提タスク** T-IDP-02
**成果物**
- `apps/human-idp/src/keys/self-bootstrap.ts`
- `apps/human-idp/src/keys/signing-key-provider.ts`
- `apps/human-idp/test/self-bootstrap.spec.ts`

**実装方針**
- 鍵種別は **RSA-2048 の RS256** にする。core の `buildProviderMetadata` が `assertHasRs256Key` を無条件に呼ぶため、ES256 のみの鍵セットでは discovery が例外になる。
- `kid` は `idp-` で始める（`idp-<base32url 8文字>`）。Agent OP は `subject_token` 検証用 JWKS を kid 接頭辞 `idp-*` に限定するため（DEC-ID-20）、この接頭辞を変えない。
- 封筒の保存先は `gs://${KEY_BUCKET}/sso-signing/current.json`。中身は `{ kid, alg: "RS256", encrypted_private_jwk, public_jwk, created_at }` とし、`encrypted_private_jwk` は KMS `encrypt` の ciphertext を base64 で入れる。
- 生成の冪等性と並行安全は GCS の生成条件で担保する。`file.save(body, { preconditionOpts: { ifGenerationMatch: 0 } })` で作成し、`412` を受けたら生成物を捨てて既存オブジェクトを読み直す。ロック用の別オブジェクトを作らない。
- 公開 JWK は `gs://${JWKS_BUCKET}/keys/${kid}.json` へ書く。`jwks.json` を Human IdP から書かない。集約は jwks-publish Job（IaC 領域）が行う。
- `signing-key-provider.ts` は core の `SigningKeyProvider` を実装し、`getSigningKey()` と `getSigningKeys()` の両方を返す。`createCachedSigningKeyProvider(base, 300_000)` で包んで `applyOidc` へ渡す。
- `SIGNER_MODE=local` のときは KMS を呼ばず、平文 JWK をローカルファイル `.local/human-idp-key.json` に置く。この分岐は統合テスト専用であり、Cloud Run の env では `kms` を渡す。

**完了条件**
- [ ] `apps/human-idp/test/self-bootstrap.spec.ts::idempotent under concurrent start` が、`bootstrap()` を10並列で呼んでも作成される鍵が1つだけであることを検証して緑になる
- [ ] `apps/human-idp/test/self-bootstrap.spec.ts::decrypts existing key` が、既存オブジェクトから復元した `kid` が保存時と一致することを検証して緑になる
- [ ] 起動後に `GET /.well-known/jwks.json`（バケットの公開 URL）が返す JWK Set に `kid` が `idp-` で始まる RSA 鍵が1件含まれる
- [ ] `apps/human-idp` のソースに `jwks.json` へ書き込むコードが存在しない（`grep -rn "jwks.json" apps/human-idp/src` が読み取り用途のみ）

---

### T-IDP-04 Firestore バックエンドのストアを実装して保持データを限定する

**概要**
生成物の `JsonStoreBackend` を Firestore 実装で差し替え、Cloud Run の複数インスタンス間でセッションと Refresh Token を共有できるようにする。
Human IdP が触れるコレクションを4種に限定し、他アプリのパスへ到達しないことをラッパで強制する。
DEC-IAC-09（データストアは Firestore 1本）と DEV-05（責務分離をアプリ側パスガードで担保）に対応する。

**対象要件** REQ-05-029
**前提タスク** T-IDP-02
**成果物**
- `apps/human-idp/src/store/firestore-backend.ts`
- `apps/human-idp/src/store/provider-stores.ts`
- `apps/human-idp/test/firestore-backend.spec.ts`

**実装方針**
- `JsonStoreBackend` の4メソッド `get<T>` / `put<T>` / `delete` / `list<T>` を Firestore で実装する。キーは接頭辞ごとにコレクションへ割り、ドキュメント ID にキーの残りを `encodeURIComponent` して使う。
- 使うコレクションは `idp_transactions` / `idp_tokens` / `idp_sessions` / `idp_users` の4つだけにする。`agents` `idp_connections` `payments` `documents` へ触れるコードを書かない。
- コレクション名の解決は `packages/gcp/src/firestore-guard.ts` の許可マトリクスを通す。`human-idp` に許可する接頭辞を上の4つで登録し、マトリクス外のパスは実行時に throw させる。
- `put` の `ttlSeconds` は `expire_at`（Timestamp）フィールドとして書く。Firestore の TTL ポリシー設定は Terraform 側（IaC 領域）が行うため、アプリから削除ジョブを回さない。
- `list(prefix)` は `expire_at > now` の where 句を必ず付ける。TTL 削除の遅延で失効済みレコードが返らないようにする。
- ストアは生成物の `createJsonProviderStores(backend)` へそのまま渡す。生成物の `store.ts` にある in-memory 実装のクラス定義は消さない（ベースライン差分を出さないため）。
- `STORE_MODE=emulator` のとき `FIRESTORE_EMULATOR_HOST` を使う。in-memory 実装へ切り替える分岐を作らない。

**完了条件**
- [ ] `apps/human-idp/test/firestore-backend.spec.ts::denies write outside allowed prefixes` が `agents/` を含むキーで throw することを検証して緑になる
- [ ] 同ファイルの `list skips expired entries` が、`expire_at` 経過済みのドキュメントを結果に含めないことを検証して緑になる
- [ ] `grep -rnE "agents|idp_connections|payments|documents" apps/human-idp/src` が 0 件を返す
- [ ] Firestore エミュレータ起動時に `pnpm --filter human-idp test:integration` が緑になる

---

### T-IDP-05 discovery の jwks_uri と ID-JAG 宣言を上書きする

**概要**
生成物の discovery ハンドラは `jwks_uri` を自分の `/​.well-known/jwks.json` にする。
これを JWKS バケットの公開 URL へ差し替え、配置プロファイルに応じて ID-JAG のメタデータを付ける。
RULE-53（JWKS は Cloud Storage から配信）と DEV-09（direct プロファイルでは ID-JAG 発行を discovery で広告しない）に対応する。

**対象要件** REQ-05-028, REQ-08-018
**前提タスク** T-IDP-03
**成果物**
- `apps/human-idp/src/oidc/routes/discovery.ts`（XAA-PATCH）
- `apps/human-idp/test/discovery.spec.ts`

**実装方針**
- `buildProviderMetadata` へ渡す `jwksUri` を `${JWKS_PUBLIC_BASE_URL}/jwks.json` にする。REQ-05-028 の本文にある `generateProviderMetadata` は実在しない名前であり、実際の関数は `buildProviderMetadata` である。
- `c.json({...metadata, ...})` のマージ位置で追加フィールドを足す。`code_challenge_methods_supported` の行は消さない。
- `identity_chaining_requested_token_types_supported: ["urn:ietf:params:oauth:token-type:id-jag"]` は **`ISSUER_PROFILE=loadbalancer` のときだけ**付ける。direct プロファイルでは `/xaa/token` が issuer と別ホストになり、issuer のメタデータから到達できないためである（DEV-09）。
- `authorization_grant_profiles_supported` を Human IdP の discovery に付けない。Human IdP は ID-JAG を受領しない。
- `registration_endpoint` を metadata に足さない。
- 手編集は `// XAA-PATCH:REQ-08-018 begin` / `end` と `// XAA-PATCH:REQ-05-028 begin` / `end` で囲む。

**完了条件**
- [ ] `apps/human-idp/test/discovery.spec.ts::advertises identity_chaining only in loadbalancer profile` が、direct でキー不在、loadbalancer で値が `["urn:ietf:params:oauth:token-type:id-jag"]` になることを検証して緑になる
- [ ] `GET /.well-known/openid-configuration` の `jwks_uri` が `JWKS_PUBLIC_BASE_URL` と `/jwks.json` の連結にバイト一致する
- [ ] 同レスポンスの `issuer` が環境変数 `ISSUER` とバイト一致する
- [ ] 同レスポンスに `registration_endpoint` キーが存在しない

---

### T-IDP-06 クライアント `automation-app` を登録する

**概要**
Automation App のログインと Control Plane 呼び出し用トークン取得に使う confidential client を登録する。
このクライアント向けの ID Token の `aud` は client_id そのものになるため、ログイン用 ID Token の audience はここで決まる。
docs 05 §1 の発行 Token 表 1行目に対応する。

**対象要件** REQ-05-002
**前提タスク** T-IDP-02
**成果物**
- `apps/human-idp/src/config/clients.ts`
- `apps/human-idp/test/clients.spec.ts`
- `e2e/test/login-id-token.spec.ts`

**実装方針**
- `clients.ts` は `ReadonlyMap<string, RegisteredClient>` を返す `createClientRegistry(env)` を export する。生成物の `defaultRegisteredClients` を使わず、`applyOidc` の `clientResolver` / `tokenClientResolver` へこのレジストリから作った resolver を渡す。
- `automation-app` の登録値は `clientType: 'confidential'`、`grantTypes: ['authorization_code', 'refresh_token']`、`tokenEndpointAuthMethod: 'client_secret_basic'`、`redirectUris: [env.AUTOMATION_APP_REDIRECT_URI]`、`clientSecret: env.CLIENT_SECRET_AUTOMATION_APP`。
- `redirectUris` は env から1件だけ取り、`http://` で始まる値を `STORE_MODE=gcp` のとき reject する検証を `createClientRegistry` に置く。
- ID Token の `aud` は core の `buildIdTokenAudience({ clientId })` が client_id 単独で組み立てる。追加 audience を渡さないことで `aud === "automation-app"`（単一文字列、`azp` なし）になる。この挙動に手を入れない。
- `defaultMaxAge` を 3600 で登録する。
- `example-client` を登録しない。

**完了条件**
- [ ] `e2e/test/login-id-token.spec.ts` が Authorization Code + PKCE でログインし、得た ID Token の `aud` が文字列 `"automation-app"` と厳密等価であることを検証して緑になる
- [ ] `apps/human-idp/test/clients.spec.ts::rejects http redirect_uri in gcp mode` が緑になる
- [ ] `GET /authorize?client_id=example-client&...` が非リダイレクトのクライアントエラーになる

---

### T-IDP-07 XAA 用クライアント `agent-platform` を登録する

**概要**
Cross App Access の `subject_token` になる ID Token と、Agent OP が保持する Refresh Token を発行するクライアントを登録する。
Agent ごとのクライアント登録は作らず、client_id はこの1つに固定する。
RULE-50 と DEC-ID-22（Agent 個体の識別は `cnf.jkt` / `act` / 監査ログの3つ）に対応する。

**対象要件** REQ-05-005
**前提タスク** T-IDP-06
**成果物**
- `apps/human-idp/src/config/clients.ts`（追記）
- `apps/human-idp/test/clients.spec.ts`（追記）
- `e2e/test/agent-platform-client.spec.ts`

**実装方針**
- 登録値は `clientType: 'confidential'`、`grantTypes: ['authorization_code', 'refresh_token']`、`tokenEndpointAuthMethod: 'client_secret_basic'`、`redirectUris: [env.AGENT_OP_CALLBACK_URI]`、`clientSecret: env.CLIENT_SECRET_AGENT_PLATFORM`。
- 許可 scope は `openid` と `offline_access` の2つだけにする（T-IDP-09 の per-client 許可表に登録する）。`workdef:submit` などの操作 scope を許可しない。
- `AGENT_OP_CALLBACK_URI` は Agent OP の `/xaa/callback` を指す。Human IdP 側でこのパスを組み立てず、env の値をそのまま登録する。
- Agent OP は `/xaa/subject-token` の処理で `grant_type=refresh_token` を `client_id=agent-platform` として実行する（DEC-ID-19）。Human IdP 側にこの経路専用の分岐を作らない。通常の refresh grant として処理する。
- `createClientRegistry` の末尾に、`agent-` で始まる client_id が `agent-platform` 以外に存在しないことを assert するガードを置き、違反時は起動時に throw する。

**完了条件**
- [ ] `e2e/test/agent-platform-client.spec.ts` が `/xaa/callback` 経由で取得した ID Token の `aud === "agent-platform"` かつ同じトークンレスポンスに `refresh_token` が含まれることを検証して緑になる
- [ ] `apps/human-idp/test/clients.spec.ts::registry has no other agent-prefixed client` が緑になる
- [ ] `agent-platform` で `scope=openid workdef:submit` を要求すると `invalid_scope` が返る

---

### T-IDP-08 Agent の文脈と動的登録を Human IdP から排除する

**概要**
Human IdP のコードとデータに Agent Registry、Agent ごとのクライアント登録、Agent 向けポリシーを持ち込まない状態を、静的検査で固定する。
Dynamic Client Registration のエンドポイントを公開しないことも同時に固定する。
RULE-47 と RULE-50 に対応する。

**対象要件** REQ-05-029
**前提タスク** T-IDP-04, T-IDP-07
**成果物**
- `apps/human-idp/test/no-agent-context.spec.ts`
- `scripts/check-human-idp-purity.sh`
- `.github/workflows/ci.yml` へジョブ `idp:purity` を追加

**実装方針**
- `check-human-idp-purity.sh` は `apps/human-idp/src` を対象に `agent_id`、`agents/`、`isolation`、`capability`、`dedicated_op` を grep し、固定文字列 `agent-platform` と `AGENT_OP_CALLBACK_URI` を除いて 1件でも残れば非ゼロ終了する。
- Human IdP が読むデータは `idp_users` / `idp_sessions`（同意記録を含む） / `idp_tokens` / `idp_transactions` に限る。T-IDP-04 の許可マトリクスがこの4つを超えないことを同スクリプトで検査する。
- `/register` を実装しない。生成物にも存在しないため、ルート追加を禁止するテストで固定する。
- 検査対象から `apps/human-idp/test` と `generated-baseline/` を除外する。

**完了条件**
- [ ] `scripts/check-human-idp-purity.sh` が現在のツリーで終了コード 0 を返す
- [ ] 同スクリプトが `apps/human-idp/src/tmp.ts` に `const agentId = 1` を置いた状態で非ゼロ終了する
- [ ] `apps/human-idp/test/no-agent-context.spec.ts::POST /register returns 404` が緑になる

---

### T-IDP-09 操作 scope を登録して未登録 scope を拒否する

**概要**
`openid` と `offline_access` に加えて、操作の種類を表す4 scope を Human IdP へ登録する。
core は `scope` に `openid` が含まれることしか検証しないため、登録済み scope への絞り込みは Human IdP 側で足す。
docs 05 §1 の発行 Token 表 scope 列と、REQ-02-013 が新設を求める `agent:operate` に対応する。

**対象要件** REQ-05-004, REQ-02-013
**前提タスク** T-IDP-07
**成果物**
- `apps/human-idp/src/config/scopes.ts`
- `apps/human-idp/src/oidc/routes/authorize.ts`（XAA-PATCH）
- `apps/human-idp/src/oidc/routes/discovery.ts`（XAA-PATCH）
- `apps/human-idp/test/scopes.spec.ts`

**実装方針**
- `SUPPORTED_SCOPES` を `['openid', 'offline_access', 'workdef:submit', 'agent:provision', 'agent:revoke', 'agent:operate']` の6件で定義する。
- per-client の許可表 `CLIENT_ALLOWED_SCOPES` を置く。`automation-app` は `openid` と操作4 scope、`agent-platform` は `openid` と `offline_access` のみ。
- `authorize.ts` の `validateAuthorizationScope(...)` 呼び出しの直後に検証ステップを挿す。`SUPPORTED_SCOPES` に無い値、または `CLIENT_ALLOWED_SCOPES[clientId]` に無い値が1つでもあれば `AuthorizationError(AuthorizationErrorCode.InvalidScope, ...)` を throw する。要求 scope を除去して継続する実装にしない。
- `error_description` に要求された scope 文字列をそのまま入れない。固定文言 `Requested scope is not registered for this client` にする。
- `discovery.ts` の `scopesSupported` を `SUPPORTED_SCOPES` に差し替える。`profile` `email` `address` `phone` は claim scope として実装していないため広告しない。
- `agent:operate` は「実行中 Agent の状況確認と追加指示」を表す。停止依頼は `agent:revoke` を使い、`agent:operate` に停止を含めない。

**完了条件**
- [ ] `scope=openid agent:provision` を要求して得た Access Token の `scope` クレームに `agent:provision` が含まれる
- [ ] `scope=openid agent:destroy` の認可要求が `error=invalid_scope` でリダイレクトされる
- [ ] `apps/human-idp/test/scopes.spec.ts` が4 scope それぞれについて肯定1件と否定1件の計8ケースで緑になる
- [ ] discovery の `scopes_supported` が `SUPPORTED_SCOPES` と要素順まで一致する

---

### T-IDP-10 audience パラメータの許可リストを実装する

**概要**
Automation App が要求できる audience をクライアント登録上の許可リストへ限定し、列挙外を `invalid_target` で拒否する。
core の認可エンドポイントには target policy が無く、`parseAudienceParameter` は文字列を配列にするだけであるため、この検証を足す。
docs 05 §1 の発行 Token 表 2〜4行目に対応する。

**対象要件** REQ-05-003
**前提タスク** T-IDP-09
**成果物**
- `apps/human-idp/src/config/allowed-targets.ts`
- `apps/human-idp/src/oidc/routes/authorize.ts`（XAA-PATCH）
- `apps/human-idp/test/allowed-targets.spec.ts`

**実装方針**
- 許可リストは client 単位で持つ。`automation-app` は `['authorization-platform', 'agent-provisioner', 'lifecycle-manager', 'automation-app']`、`agent-platform` は `[]`。
- `authorize.ts` の `const audience = parseAudienceParameter(effectiveParams);` の直後に検証を挿す。`audience` が `undefined` でなく、要素数が 0 または 2 以上、あるいは許可リスト外を含む場合は、`buildErrorRedirect(redirectUri, 'invalid_target', state, 'The requested audience is not allowed for this client', issuer)` へリダイレクトする。
- `invalid_target` は core の `AuthorizationErrorCode` に無い。enum を拡張せず、`buildErrorRedirect` の第2引数が `string` である点を使って文字列で渡す。
- `audience` パラメータをトークン要求のボディから読まない。authorization_code grant の audience は認可要求時の値がトランザクションと認可コードを経由して `validatedRequest.audience` に入るため、`/token` 側で再度パースすると経路が二重になる。
- 許可リストの内容を discovery やエラー応答へ露出させない。

**完了条件**
- [ ] `audience=agent-provisioner` の認可要求が成功し、`audience=unknown-app` が `error=invalid_target` でリダイレクトされる e2e テストが緑になる
- [ ] `audience=agent-provisioner lifecycle-manager`（2値）が `invalid_target` になる
- [ ] `client_id=agent-platform` で `audience` を付けた要求が `invalid_target` になる
- [ ] `error_description` に要求された audience 値が含まれない

---

### T-IDP-11 scope から audience を決める対応表を実装する

**概要**
操作 scope と Access Token の `aud` の対応を1つの表に固定し、`buildAccessTokenAudience` へ渡す値をその表から決める。
`aud` は core が UserInfo エンドポイントを常に含めるため2要素以上になる。この点は逸脱として受け入れ、判定側を要素一致に揃える。
REQ-02-011 の「1値に固定する」を DEV-12 に従って読み替えた実装になる。

**対象要件** REQ-02-011, REQ-05-003
**前提タスク** T-IDP-10
**成果物**
- `apps/human-idp/src/config/audience-map.ts`
- `apps/human-idp/src/oidc/routes/authorize.ts`（XAA-PATCH）
- `packages/xaa-contracts/src/audience.ts`
- `packages/xaa-contracts/test/audience.spec.ts`
- `apps/human-idp/test/audience-map.spec.ts`

**実装方針**
- 対応表は `SCOPE_TO_AUDIENCE` として次の4行で固定する。`workdef:submit` → `authorization-platform`、`agent:provision` → `agent-provisioner`、`agent:revoke` → `lifecycle-manager`、`agent:operate` → `automation-app`。
- 決定の順序を次に固定する。(1) 要求 scope から操作 scope を抜き出す、(2) 対応表で audience 集合へ写す、(3) 集合が2要素以上なら `invalid_scope`、(4) `audience` パラメータが無ければ写した1件を採用、(5) `audience` パラメータがあり写した値とバイト一致しなければ `invalid_target`。
- 操作 scope が1つも無い要求（`scope=openid` や `scope=openid offline_access`）では audience を `undefined` のままにする。この経路の ID Token の `aud` は client_id であり、これが `automation-app` と `agent-platform` の2値を生む。5種の audience は「ID Token 2種（client_id 由来）」と「Access Token 3種（対応表由来）」の合算で満たす。
- `/token` 側の `buildAccessTokenAudience({ userInfoEndpoint, requested, issuer })` の呼び出しを変更しない。`userInfoEndpoint` を外すと core の UserInfo 検証が通らなくなる。
- `packages/xaa-contracts/src/audience.ts` に `audienceIncludes(aud: string | string[], expected: string): boolean` を置く。配列化したうえで要素の厳密等価だけで判定し、`startsWith` や `includes(substring)` を使わない。Control Plane 各アプリはこの関数で `aud` を検証する。

**完了条件**
- [ ] `scope=openid workdef:submit` で得た Access Token の `aud` が `audienceIncludes(aud, 'authorization-platform')` で true になり、`aud` の要素数が 2 である
- [ ] `scope=openid agent:provision` で得た Access Token が `audienceIncludes(aud, 'agent-provisioner')` で true になる
- [ ] `packages/xaa-contracts/test/audience.spec.ts::element match, no prefix/substring match` が `authorization-platform-x` と `authorization` の両方で false を返して緑になる
- [ ] `scope=openid workdef:submit agent:provision` が `invalid_scope` になる

---

### T-IDP-12 scope と typ を検査する保護ミドルウェアを提供する

**概要**
発行した Access Token を受け取る側が、必要な scope を持たないトークンを 403 と `insufficient_scope` で拒否できるようにする。
共有 issuer と共有 JWKS のもとでは ID Token と Access Token が同じ鍵で並ぶため、署名検証の直後に `typ` を検査する。
RULE-06 と DEC-ID-18 に対応し、REQ-02-013 の 403 側を満たす。

**対象要件** REQ-02-013
**前提タスク** T-IDP-11
**成果物**
- `packages/xaa-contracts/src/scope-guard.ts`
- `packages/xaa-contracts/src/token-types.ts`
- `packages/xaa-contracts/test/scope-guard.spec.ts`

**実装方針**
- `requireScope(scope: string, audience: string)` を Hono ミドルウェアとして export する。検証順序を 署名検証 → `typ` 検査 → `iss` 一致 → `aud` 要素一致 → `exp` → `scope` 包含 に固定する。
- `typ` が `at+jwt` 以外なら 401 を返す。`JWT`（ID Token）と `oauth-id-jag+jwt`（ID-JAG）はここで落ちる。
- scope 不足は 403 と `{"error":"insufficient_scope"}`、ヘッダ `WWW-Authenticate: DPoP error="insufficient_scope", scope="<required>"` を返す。401 にしない。
- `aud` の判定は T-IDP-11 の `audienceIncludes` を使う。文字列比較を書き直さない。
- 各アプリのエンドポイントへの適用（Business Work Request に `workdef:submit`、Agent Provisioning Request に `agent:provision`、停止依頼に `agent:revoke`、状況確認と追加指示に `agent:operate`）は AUTHZ / PROV / LIFE / APP の各領域が自分のルートで `requireScope` を mount する。本タスクは関数と契約テストまでを持つ。
- JWKS の取得は `JWKS_PUBLIC_BASE_URL` からの HTTP GET とし、`kid` 単位で 300 秒キャッシュする。

**完了条件**
- [ ] `packages/xaa-contracts/test/scope-guard.spec.ts::rejects id token with 401` が `typ=JWT` のトークンで 401 を返して緑になる
- [ ] 同ファイルの `returns 403 insufficient_scope` が、`workdef:submit` だけを持つトークンで `agent:provision` を要求した場合に 403 と `WWW-Authenticate` ヘッダを返して緑になる
- [ ] 同ファイルの `rejects wrong audience` が、`aud` に対象アプリを含まないトークンで 401 を返して緑になる
- [ ] 4 scope すべてについて肯定1件と否定1件が並んでいる

---

### T-IDP-13 offline_access の同意判定フックを差し替える

**概要**
core は `offline_access` の付与に `prompt=consent` を要求する。
これを差し替え、同意記録が残っている `agent-platform` の再認可では `prompt=none` でも Refresh Token を発行できるようにする。
RULE-51 と docs 05 §4.1 の「同意済みであれば prompt=none で無操作にできる」に対応する。

**対象要件** REQ-05-006
**前提タスク** T-IDP-04, T-IDP-07
**成果物**
- `apps/human-idp/src/auth/offline-access-policy.ts`
- `apps/human-idp/src/oidc/routes/authorize.ts`（XAA-PATCH）
- `apps/human-idp/test/offline-access-policy.spec.ts`

**実装方針**
- `authorize.ts` の `scope = await applyOfflineAccessPolicy(scope, effectiveParams, prompt, client);` に第5引数を足す形で差し替える。ステップ関数の呼び出し順序を変えない。
- 差し替えるコールバックは `OfflineAccessGrantedCallback` の型に合わせ、`(request, { promptValues, client }) => Promise<boolean>` を返す。判定は次の順で行う。(1) `clientAllowsRefreshTokenGrant(client)` が false なら false、(2) `promptValues.includes('consent')` なら true、(3) `client.clientId !== 'agent-platform'` なら false、(4) Cookie から解決した subject の同意記録が要求 scope 集合を包含していれば true、(5) それ以外は false。
- subject の解決は生成物の `store.ts` が export する `parseSessionId(cookieHeader)` と `browserSessionStore.get(sessionId)` を使う。`sessionResolver` をここで呼ばない（同じ Request を二度読む形にしないため）。
- 同意記録の照合は `consentResolver.hasConsent(subject, clientId, scopes)` を使う。独自の同意テーブルを作らない。
- (5) に落ちた場合、`offline_access` を黙って除去するのではなく、`prompt=none` を含む要求に限り `AuthorizationError(AuthorizationErrorCode.InteractionRequired, ...)` を throw する。記録が無いのに Refresh Token 無しで成功させると Provisioner が原因を判別できない。
- `prompt` が指定されていない要求では従来どおり `offline_access` を除去して継続する。

**完了条件**
- [ ] `apps/human-idp/test/offline-access-policy.spec.ts::grants refresh token with prompt=none when consent recorded` が緑になる
- [ ] 同ファイルの `returns interaction_required when no consent record` が緑になる
- [ ] 同ファイルの `never grants offline_access to automation-app under prompt=none` が緑になる
- [ ] `prompt=consent` の経路が差し替え前と同じ結果になることを回帰テストで確認する

---

### T-IDP-14 prompt=none による無操作の再認可を成立させる

**概要**
2体目以降の Agent の Provisioning で同意画面を出さずに `/xaa/callback` まで到達できるようにする。
セッション解決と同意解決を Firestore バックエンドのストアへ接続し、core の prompt 検証と `AuthorizationErrorCode` をそのまま使う。
docs 07 §3.3 に対応する。

**対象要件** REQ-07-010
**前提タスク** T-IDP-13
**成果物**
- `apps/human-idp/src/app.ts`（`sessionResolver` / `consentResolver` の注入）
- `e2e/test/prompt-none.spec.ts`

**実装方針**
- `applyOidc` の `sessionResolver` と `consentResolver` に、`createStoreResolvers(providerStores)` の戻り値を渡す。生成物の in-memory 既定値を使わない。
- ブラウザセッション Cookie は生成物の `buildSessionCookie` が出す `HttpOnly; Secure; SameSite=Lax` のまま使う。属性を変更しない。
- `login_required` / `consent_required` / `interaction_required` の3コードを Human IdP 側で作り直さない。core が返すものをそのまま `error` クエリで返す。
- Provisioner 側の「まず prompt=none、失敗したら prompt=consent」という再試行は PROV 領域が実装する。Human IdP 側は、同じ入力に対して常に同じ error コードを返すことだけを保証する。
- セッション有効期間は `idp_sessions` の `expire_at` で管理し、既定を 8 時間にする。

**完了条件**
- [ ] `e2e/test/prompt-none.spec.ts` で、1体目の Provisioning が同意画面を1回経由し、2体目が同意画面のクリック 0 回で完了する
- [ ] セッション Cookie を削除した状態の `prompt=none` が `error=login_required` になる
- [ ] 同意記録を削除した状態の `prompt=none` が `error=interaction_required` になる
- [ ] `prompt=none login` の組み合わせが `invalid_request` になる（core の既存挙動の回帰）

---

### T-IDP-15 Refresh Token Rotation と再利用検知を成立させる

**概要**
rotation 済みの Refresh Token が再提示されたとき、同じ grantId のトークン一族をすべて失効させる。
core は `revokeTokensByGrantId` を呼ぶ側を持っているため、Firestore 実装の grantId 検索と検知イベント送出を足す。
RULE-51 と docs 09 §5.1 に対応する。

**対象要件** REQ-05-050
**前提タスク** T-IDP-04
**成果物**
- `apps/human-idp/src/store/firestore-backend.ts`（`revokeByGrantId` の実装）
- `apps/human-idp/src/security/reuse-detection.ts`
- `apps/human-idp/test/refresh-rotation.spec.ts`
- `e2e/test/refresh-reuse.spec.ts`

**実装方針**
- `RefreshTokenStorage.consume(token)` を物理削除で実装しない。`used: true` への更新にする。削除にすると再提示が `not found` になり `revokeTokensByGrantId` が発火しない。
- `resolve` は `used: true` のレコードを Refresh Token の絶対寿命（`refreshTokenAbsoluteLifetime`、既定 7776000 秒）が過ぎるまで返し続ける。
- `revokeByGrantId(grantId)` は `idp_tokens` を `grant_id == grantId` で query し、Access Token と Refresh Token の両方を `revoked: true` に更新する。バッチは `writeBatch` で 500 件単位に分ける。
- 検知イベントは `reuse-detection.ts` の `emitRefreshTokenReuse({ grantId, clientId, subject, jti })` から構造化ログとして出す。Refresh Token の値そのものをログへ入れない（RULE-38）。`event_type` は `refresh_token_reuse` に固定する。
- 呼び出し位置は生成物の `resolvers.ts` の `refreshTokenResolver.revokeTokensByGrantId` をラップする形にする。core の `validateRefreshTokenUnused` に手を入れない。
- Security Detection 側の SQL はこのログの `event_type` を条件にする。BigQuery 側の実装は SEC 領域が持つ。

**完了条件**
- [ ] `e2e/test/refresh-reuse.spec.ts` で、rotation 前の Refresh Token の再提示が `invalid_grant` になり、その後 rotation 後の Refresh Token も `invalid_grant` になる
- [ ] 同シナリオで発行済みの Access Token が introspection で `active: false` になる
- [ ] `apps/human-idp/test/refresh-rotation.spec.ts::consume marks used instead of deleting` が緑になる
- [ ] 上記シナリオの実行後、`event_type=refresh_token_reuse` の構造化ログが 1 件だけ出力され、その中に Refresh Token 文字列が含まれない

---

### T-IDP-16 Revoke を Refresh Token 単位に限定する

**概要**
Cleanup は当該 Agent の Refresh Token だけを失効させる。
同じ人間の他の Agent の Refresh Token と、その人間の SSO セッションを巻き込まない状態を実装と検査で固定する。
RULE-51 と docs 07 §6 に対応する。

**対象要件** REQ-07-022
**前提タスク** T-IDP-15
**成果物**
- `apps/human-idp/src/oidc/routes/revocation.ts`（検査のみ、手編集なし）
- `apps/human-idp/test/revocation-scope.spec.ts`
- `e2e/test/per-agent-revoke.spec.ts`

**実装方針**
- 生成物の `/revoke` は RFC 7009 に沿って「提示されたトークンと同一 grantId の Access Token」だけを失効させる。この挙動を変えない。
- `sub` 単位で一括失効する経路を実装しない。`revokeConsentAndTokens(subject, clientId)` はユーザー自身の「アクセス解除」用であり、`/revoke` から呼ばない。生成物の該当行を消さず、ルートから到達しないことをテストで固定する。
- ブラウザセッション（`idp_sessions`）を `/revoke` から削除しない。
- 全 Agent の Revoke は、Agent ごとの Cleanup を Lifecycle Manager がループして行う（LIFE 領域）。Human IdP 側に一括 API を足さない。
- `/revoke` のクライアント認証は `agent-platform` の `client_secret_basic` で行う。他クライアントのトークンを渡した場合は core の `validateRevocationTokenClient` が `invalid_grant` を返す。

**完了条件**
- [ ] `e2e/test/per-agent-revoke.spec.ts` で、Agent A の Refresh Token を revoke した後も Agent B の `subject_token` 再取得が 200 で成功する
- [ ] 同テストで、revoke 後にブラウザの SSO セッションによる `/authorize` が再ログインを求めない
- [ ] `apps/human-idp/test/revocation-scope.spec.ts::revocation route never calls revokeConsentAndTokens` が緑になる
- [ ] `grep -rn "revokeConsentAndTokens" apps/human-idp/src/oidc/routes/` が 0 件を返す

---

### T-IDP-17 /token で token-exchange を拒否する

**概要**
Human IdP は ID-JAG を発行しない。
`grant_type=urn:ietf:params:oauth:grant-type:token-exchange` を受け取ったら `unsupported_grant_type` を返す状態を固定する。
RULE-47 と DEC-ID-03（Human IdP が提供するのは `/authorize` `/token` `/userinfo` `/logout` `/.well-known/openid-configuration` のみ）に対応する。

**対象要件** REQ-05-030
**前提タスク** T-IDP-01
**成果物**
- `apps/human-idp/test/no-token-exchange.spec.ts`
- `scripts/check-human-idp-purity.sh`（追記）

**実装方針**
- T-IDP-01 で `--enable token-exchange` と `--enable id-jag` を付けていないため、生成物の `/token` は core の `supportedGrantTypes` 既定値 `['authorization_code', 'refresh_token']` で動く。この既定値を上書きしない。
- `supportedGrantTypes` を明示的に渡す実装を足さない。core の既定に任せることで、feature を後から有効化しても分岐が二重にならない。
- `check-human-idp-purity.sh` に `@maronn-openid-connect/experimental` の import が `apps/human-idp/src` に無いことの検査を足す。
- `unsupported_grant_type` の HTTP ステータスは core が返す 400 のままにする。
- `jwt-bearer` grant も同様に拒否されることを同じテストで確認する。

**完了条件**
- [ ] `apps/human-idp/test/no-token-exchange.spec.ts::rejects token-exchange with unsupported_grant_type` が 400 と `{"error":"unsupported_grant_type"}` を検証して緑になる
- [ ] 同ファイルの `rejects jwt-bearer` が緑になる
- [ ] `grep -rn "@maronn-openid-connect/experimental" apps/human-idp/src` が 0 件を返す
- [ ] discovery の `grant_types_supported` が `["authorization_code","refresh_token"]` と一致する

---

### T-IDP-18 DPoP 束縛 Access Token を発行する

**概要**
Automation App から Control Plane 3アプリへ渡る Access Token を、鍵に束縛したトークンとして発行する。
`/token` で DPoP Proof を検証し、Access Token の payload と introspection 応答に `cnf.jkt` を載せ、`token_type` を `DPoP` にする。
RULE-06 と DEC-ID-13 の経路(3)の発行側にあたる。maronn は DPoP 非対応のため実装は `packages/xaa-crypto` を使う（DEV-01）。

**対象要件** REQ-05-018, REQ-02-014
**前提タスク** T-IDP-11
**成果物**
- `apps/human-idp/src/auth/dpop-token-binding.ts`
- `apps/human-idp/src/oidc/routes/token.ts`（XAA-PATCH）
- `apps/human-idp/src/oidc/routes/introspection.ts`（XAA-PATCH）
- `apps/human-idp/test/dpop-binding.spec.ts`

**実装方針**
- Proof の検証は `packages/xaa-crypto` の `verifyProof({ proof, htm, htu })` を使う。`htm` は `POST`、`htu` は query と fragment を除いた `${ISSUER}/token`。
- 検証順序は 署名 → `typ`（`dpop+jwt`） → `htm` → `htu` → `iat` 窓（±60秒） → `jti` 重複 → `ath` 一致 に固定する（DEC-ID-12）。`/token` では Access Token をまだ提示していないため `ath` を要求しない。
- `jti` の重複排除は Firestore の `dpop_jti` コレクション（TTL 120秒）で行う。`idp_tokens` に混ぜない。
- `cnf.jkt` は RFC 7638 の thumbprint（SHA-256、base64url）を `packages/xaa-crypto` の `jwkThumbprint(jwk)` から得る。
- `buildAccessTokenPayload(...)` の戻り値をスプレッドして `{ ...payload, cnf: { jkt } }` を作り、`accessTokenIssuer.issue({ payload, ... })` へ渡す。`AccessTokenPayload` は `[key: string]: unknown` を持つためキャストは不要。
- トークン応答の `token_type` を `DPoP` にする。`Bearer` を返す分岐は `DPOP_REQUIRED=false` かつ `DPoP` ヘッダ不在のときだけ残す。
- `DPOP_REQUIRED=true` で `DPoP` ヘッダが無い、あるいは検証に失敗した場合は 400 と `{"error":"invalid_dpop_proof"}` を返す。
- introspection 応答に `cnf` をそのまま含める。`idp_tokens` のレコードにも `cnf` を保存する。
- `/authorize` に DPoP を要求しない。ブラウザリダイレクトの経路であり Proof を作れない。

**完了条件**
- [ ] `apps/human-idp/test/dpop-binding.spec.ts::binds cnf.jkt to the proof key` が、応答の `token_type === "DPoP"` かつ Access Token の `cnf.jkt` が送った Proof の JWK の thumbprint と一致することを検証して緑になる
- [ ] `DPOP_REQUIRED=true` で DPoP ヘッダ無しの `/token` が 400 と `invalid_dpop_proof` を返す
- [ ] 同一 `jti` の Proof を2回送ると2回目が `invalid_dpop_proof` になる
- [ ] introspection 応答の `cnf.jkt` が Access Token の値と一致する

---

### T-IDP-19 Human IdP の構造化ログを出力する

**概要**
認証処理ごとに、検知に使う7項目と全アプリ共通の4フィールドを構造化ログへ出す。
Raw Token とシークレットをログへ残さない。
docs 09 §2 の Human IdP 行と RULE-38 に対応する。

**対象要件** REQ-09-004
**前提タスク** T-IDP-18
**成果物**
- `apps/human-idp/src/log/audit-log.ts`
- `packages/xaa-contracts/src/log-constants.ts`
- `e2e/specs/logging/human-idp-log.spec.ts`

**実装方針**
- 出力は Cloud Logging が解釈する JSON 1行とし、`console.log(JSON.stringify(entry))` で stdout へ出す。ログライブラリを追加しない（DEC-APP-08）。
- 共通4フィールドは `human_subject` / `agent_id` / `trace_id` / `timestamp`。Human IdP は Agent を知らないため `agent_id` は常に `null` を入れる。キー自体は省略しない。
- `trace_id` は `X-Cloud-Trace-Context` ヘッダから抽出し、無ければリクエストごとに生成する。
- 固有7項目は `client_id` / `audience` / `scope` / `auth_result` / `failure_code` / `dpop_status` / `source_ip` / `user_agent` とする。`auth_result` は `success` と `failure` の2値、`failure_code` は成功時 `null`。
- `dpop_status` の値集合を `packages/xaa-contracts/src/log-constants.ts` に `DPOP_STATUS = { valid, invalid, absent, not_applicable }` として定義し、各値の意味をコメントで書く。`/token` は `valid` / `invalid` / `absent` を、DPoP を適用しない `/authorize` と `/userinfo` は `not_applicable` を入れる。
- 出力位置は `/authorize` の完了時、`/token` の応答直前、`/revoke` の応答直前の3か所に限る。ミドルウェアで全リクエストへ出さない。
- Access Token、ID Token、Refresh Token、Authorization Code、`client_secret`、DPoP Proof の生値をログへ入れない。トークンを指す必要があるときは `jti` と `kid` と `jkt` を使う。

**完了条件**
- [ ] `e2e/specs/logging/human-idp-log.spec.ts` が認証成功1回と失敗1回を実行し、両方のログ行に固有7項目と共通4フィールドが揃っていることを assert して緑になる
- [ ] 同テストが、出力されたログ行に `eyJ` で始まる文字列が含まれないことを assert して緑になる
- [ ] `dpop_status` が `/token` で `valid`、`/authorize` で `not_applicable` になる
- [ ] 失敗ログの `failure_code` が `invalid_client` / `invalid_scope` / `invalid_target` / `invalid_dpop_proof` のいずれかになる

---

## このファイルで扱わない要件

該当なし。
要件ファイルの18件はすべて上記のいずれかのタスクに入っている。
ただし REQ-02-013 のうち、`requireScope` を各エンドポイントへ mount する作業は T-IDP-12 の成果物を使う側の作業であり、AUTHZ / PROV / LIFE / APP の各ファイルが持つ。
