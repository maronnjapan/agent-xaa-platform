# 05. リソースサーバー2種（T-RES）

この領域は、Agent が実際にデータへ触る先である2つのリソースサーバーを作る。
ひとつはドキュメントアプリ（Document）で、文書の読み取りと書き込みを提供する。
もうひとつは金融系（Finance）で、支払の参照と承認を提供し、Agent が完全隔離（FULL_ISOLATION）で動いている場合しか受け付けない。
どちらも「Authorization Server（AS）」と「Resource API」の2つの Cloud Run Service で構成し、AS は Agent OP が発行した ID-JAG を `jwt-bearer` grant で受け取って自分の Access Token に引き換え、API はその Access Token と DPoP Proof を検証してから業務データを返す。
AS は ID-JAG を発行しない。発行できるのは Agent OP だけであり、この領域が作るのは受領側だけである。

| 前提 | 内容 |
|---|---|
| 依存する領域 | Identity（Agent OP の ID-JAG 発行、`cnf.jkt` と `isolation_level` の付与）、IaC（Cloud Run、KMS、JWKS バケット、Firestore、Terraform 変数）、共通パッケージ（`packages/xaa-crypto` の DPoP、`packages/xaa-contracts` の定数）、Authorization（Capability Taxonomy と Risk Policy）、Runtime（Tool Executor 側の呼び出しと constraint 事前検証） |
| このファイルのタスク数 | 23件 |
| 主に満たす設計ルール | RULE-06, RULE-15, RULE-16, RULE-21, RULE-30, RULE-36, RULE-38, RULE-44, RULE-45, RULE-46, RULE-48, RULE-50, RULE-52 |

用語を先に固定する。

**Resource AS**：`resource-docs-as` と `resource-finance-as`。ID-JAG を受領して Access Token を発行する。
**Resource API**：`resource-docs-api` と `resource-finance-api`。Access Token を検証して業務データを返す。
**ID-JAG**：Agent OP が発行する `typ=oauth-id-jag+jwt` の JWT。`sub` が委譲元の人間、`act.sub` が Agent。

---

### T-RES-01 Resource AS 2種を CLI 生成物として作成する

**概要**
`maronn-oidc generate hono --enable id-jag` の生成物を Document 用と Finance 用の2つ作り、リポジトリへコミットする。
生成物への手編集は差分検知できる形に閉じ込め、無改変版を別に残す。
DEC-ID-01 の「4系統の OP のうち Resource AS 2種は生成物を使う」と、DEC-APP-04 の生成物運用に対応する。

**対象要件** REQ-05-007, REQ-05-008
**前提タスク** なし
**成果物**
- `apps/resource-docs-as/package.json`
- `apps/resource-docs-as/src/index.ts`
- `apps/resource-docs-as/src/app.ts`
- `apps/resource-docs-as/src/oidc/`（`app.ts` `apply.ts` `config.ts` `store.ts` `resolvers.ts` `views.ts` `routes/authorize.ts` `routes/token.ts` `routes/userinfo.ts` `routes/jwks.ts` `routes/discovery.ts` `routes/login.ts` `routes/consent.ts` `conformance.test.ts`）
- `apps/resource-finance-as/` に同じ構成
- `generated-baseline/resource-docs-as/`, `generated-baseline/resource-finance-as/`
- `scripts/generate-oidc.sh`

**実装方針**
- 生成コマンドを `scripts/generate-oidc.sh` に固定し、CLI のバージョンを `package.json` の devDependencies と同じ exact 値で指定する。
- 生成直後の内容をそのまま `generated-baseline/<app>/` へコピーし、`apps/<app>/src/oidc/` を作業コピーとする。
- 手編集は `// XAA-PATCH:<REQ-ID> begin` と `// XAA-PATCH:<REQ-ID> end` で囲む。マーカー外の差分を作らない。
- `src/app.ts` は `createApp(): Hono` を default export する（DEC-APP-07 の統合テスト方式が要求する）。
- `src/index.ts` は `@hono/node-server` の `serve` を呼ぶだけにし、環境変数 `PORT` を読む。
- `/authorize` `/login` `/consent` `/userinfo` は Resource AS では使わない。生成ファイルは削除せず、`src/app.ts` の XAA-PATCH でルート登録だけを外す。
- 無認証の `GET /healthz` を `src/app.ts` に追加し、固定 JSON `{"status":"ok"}` を返す。
- コンテナはリポジトリ直下の単一 Dockerfile を `--build-arg APP=resource-docs-as` で切り替える。アプリ個別の Dockerfile を作らない。

**完了条件**
- [ ] `bash scripts/generate-oidc.sh --check` が `generated-baseline/` と CLI 再生成物のバイト一致を報告し、終了コード0で終わる
- [ ] `pnpm -F resource-docs-as build` と `pnpm -F resource-finance-as build` が tsc エラー0で完了する
- [ ] `pnpm run check:patch-markers` が `apps/resource-*-as/src/oidc/` の baseline 差分をすべて XAA-PATCH マーカー内と判定する
- [ ] `createApp()` を import した vitest から `GET /healthz` を `app.fetch` で叩き 200 が返る

---

### T-RES-02 生成 OP のストアを Firestore バックエンドへ差し替える

**概要**
生成物の `JsonStoreBackend` を Firestore 実装で満たし、両 Resource AS のストアを差し替える。
アプリごとのパス境界は `firestore-guard` の許可マトリクスで強制する。
DEC-IAC-09 の「データストアは Firestore 1本」と DEV-05 に対応する。

**対象要件** REQ-05-007, REQ-05-008
**前提タスク** T-RES-01
**成果物**
- `packages/gcp/src/firestore-json-store.ts`
- `packages/gcp/src/firestore-guard.ts`（許可マトリクスへの追記）
- `packages/gcp/test/firestore-json-store.spec.ts`
- `apps/resource-docs-as/src/store/backend.ts`
- `apps/resource-finance-as/src/store/backend.ts`
- `apps/resource-*-as/src/oidc/apply.ts`（XAA-PATCH でバックエンド注入）

**実装方針**
- `createFirestoreJsonStore(appId: string): JsonStoreBackend` を export し、`get` `put` `delete` `list` の4メソッドを実装する。
- ドキュメントパスは `op_store/{appId}/entries/{encodeKey(key)}` に固定する。`encodeKey` は base64url とし、Firestore が禁じる文字を含めない。
- `put` の `ttlSeconds` は `expire_at`（Timestamp）フィールドへ変換し、Firestore の TTL ポリシーを `infra/envs/demo/firestore.tf` で `op_store` に設定する。
- `list(prefix)` は doc ID の範囲クエリ（`>= prefix` かつ `< prefix + '\uf8ff'`）で引き、`expire_at` が現在時刻より前のエントリを結果から除く。
- `firestore-guard` の許可マトリクスに `resource-docs-as` → `op_store/resource-docs-as/**`、`resource-finance-as` → `op_store/resource-finance-as/**`、`resource-docs-api` → `documents/**`、`resource-finance-api` → `payments/**` を追加する。範囲外パスは `path_not_allowed` を throw する。
- `STORE_MODE=emulator|gcp` で接続先を切り替える（DEC-APP-09）。emulator では `FIRESTORE_EMULATOR_HOST` を読む。
- Cloud SQL 実装と Firestore Security Rules を作らない。

**完了条件**
- [ ] `pnpm -F @xaa/gcp test` の `firestore-json-store.spec.ts` が get / put / delete / list / TTL 期限切れ除外の5ケースで緑になる
- [ ] `STORE_MODE=emulator` で両 Resource AS の統合テストが起動し、Access Token のストア書き込みと読み出しが成立する
- [ ] `resource-docs-as` の識別子で `payments/pay_x` へアクセスすると `path_not_allowed` が throw されるテストが緑になる
- [ ] `apps/resource-*-as/src/oidc/store.ts` に手編集が入っていない（差し替えは `apply.ts` の注入のみ）

---

### T-RES-03 Resource AS から ID-JAG 発行分岐と discovery の発行広告を削除する

**概要**
生成物には ID-JAG の発行分岐（token-exchange grant）と受領分岐の両方が入る。
発行できるのは Agent OP だけという DEC-ID-21 を満たすため、Resource AS 側の発行分岐と discovery の発行広告を削除する。
署名鍵の用途を Access Token に限定し、RULE-48 の「ID-JAG 署名鍵の分離」を Resource AS 側からも崩さない。

**対象要件** REQ-05-084
**前提タスク** T-RES-01
**成果物**
- `apps/resource-docs-as/src/oidc/routes/token.ts`（XAA-PATCH）
- `apps/resource-docs-as/src/oidc/routes/discovery.ts`（XAA-PATCH）
- `apps/resource-docs-as/src/oidc/config.ts`（XAA-PATCH）
- `apps/resource-finance-as/` に同じ3ファイル
- `apps/resource-docs-as/test/discovery.spec.ts`
- `apps/resource-finance-as/test/discovery.spec.ts`

**実装方針**
- `routes/token.ts` の `grant_type === TOKEN_EXCHANGE_GRANT_TYPE` の分岐を丸ごと削除し、当該 grant_type を受けたら core の `unsupported_grant_type` へ落ちるようにする。
- `config.ts` の `agent-platform` の `grantTypes` を `['urn:ietf:params:oauth:grant-type:jwt-bearer']` の1件だけにする。token-exchange URN を登録しない。
- `idJagConfig` から発行側の設定（`allowedAudiences`, `allowActorTokens`, `actorTokenResolver`, `idJagLifetimeSeconds`, `allowRefreshTokenSubjects`）を削除し、`trustedIdentityProviders` と受領側の設定だけを残す。
- `routes/discovery.ts` から `identity_chaining_requested_token_types_supported` の行を削除する。`authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag']` は残す。
- `@maronn-openid-connect/experimental/id-jag` からの import を受領側の関数（`JWT_BEARER_GRANT_TYPE`, `authorizeIdJagRedemptionClient`, `parseIdJagRedemptionParams`, `verifyIdJagAssertion`, `resolveIdJagGrantScope`, `IdJagError`, `IdJagAccessTokenInfo`）に限る。
- 発行側関数（`processIdJagIssuanceRequest`, `signIdJag`, `buildIdJagClaims`）を import しない。

**完了条件**
- [ ] `apps/resource-docs-as/test/discovery.spec.ts::no identity_chaining, keeps authorization_grant_profiles` が緑になる
- [ ] `apps/resource-finance-as/test/discovery.spec.ts` の同名テストが緑になる
- [ ] `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` の POST が 400 `unsupported_grant_type` を返すテストが緑になる
- [ ] `grep -R "processIdJagIssuanceRequest\|signIdJag\|buildIdJagClaims" apps/resource-docs-as apps/resource-finance-as` の結果が0件になる

---

### T-RES-04 Resource AS の署名鍵を自己ブートストラップし JWKS へ公開する

**概要**
Resource AS は自分の Access Token を自分の鍵で署名する。
core の `SigningKeyProvider` が `CryptoKey` を要求するため KMS の asymmetricSign を使えず、KMS で封筒暗号した JWK を GCS に置いて起動時に復号する方式にする。
DEC-ID-17 と DEV-10 に対応し、docs 側の鍵で finance のトークンを署名できない状態を鍵単位の IAM で作る。

**対象要件** REQ-05-086
**前提タスク** T-RES-01
**成果物**
- `packages/gcp/src/kms-envelope.ts`
- `apps/resource-docs-as/src/keys/self-bootstrap.ts`
- `apps/resource-finance-as/src/keys/self-bootstrap.ts`
- `apps/resource-docs-as/test/self-bootstrap.spec.ts`
- `apps/resource-finance-as/test/self-bootstrap.spec.ts`

**実装方針**
- `ensureSigningKey(options: { bucket: string; object: string; kmsKeyName: string; kidPrefix: string }): Promise<{ jwk: JsonWebKey; kid: string }>` を実装する。
- 既存オブジェクトがあれば GCS から読み、`packages/gcp` の `kmsDecrypt` で復号し、`crypto.subtle.importKey('jwk', ..., { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])` で `CryptoKey` にする。
- 無ければ `crypto.subtle.generateKey` で ES256 鍵対を作り、秘密 JWK を `kmsEncrypt` し、GCS へ `ifGenerationMatch: 0` 付きで書く。412 が返ったら書き込みを捨てて読み直す（並行起動の冪等性）。
- `kid` は `docs-as-<8桁hex>` と `fin-as-<8桁hex>` にする。乱数ではなく公開 JWK の RFC 7638 thumbprint 先頭8文字から作り、再起動で変わらないようにする。
- 公開 JWK は JWKS バケットの `keys/<kidPrefix>-<kid>.json` にだけ書く。`jwks.json` を直接書かない（集約は jwks-publish Job が行う）。
- 環境変数は `SIGNING_KEY_BUCKET`, `SIGNING_KEY_OBJECT`, `SIGNING_KEY_KMS_KEY`, `JWKS_BUCKET`, `JWKS_KEY_PREFIX` とする。
- KMS 鍵は docs と finance で別 CryptoKey（`resource-as-signing/docs` と `resource-as-signing/finance`）を指す。相手の鍵名を設定できる分岐を作らない。
- `SIGNER_MODE=local` のときは環境変数 `LOCAL_SIGNING_JWK` の JWK を使い、GCS と KMS を呼ばない。

**完了条件**
- [ ] `apps/resource-docs-as/test/self-bootstrap.spec.ts::idempotent under concurrent start` が10並列の `ensureSigningKey` 呼び出しで生成される鍵が1本になることを assert する
- [ ] 既存オブジェクトがある場合に生成せず復号だけを行うテストが緑になる
- [ ] finance の KMS 鍵名で docs の暗号化オブジェクトを復号すると失敗するテストが緑になる
- [ ] finance AS が発行した Access Token のヘッダ `kid` が `fin-as-` で始まることを assert する統合テストが緑になる

---

### T-RES-05 信頼 IdP と共有 JWKS の解決を設定値に固定する

**概要**
Resource AS は Agent OP が署名した ID-JAG を検証する。
検証鍵の取得先を assertion の内容から導出させず、設定値の1本に固定する。
DEC-ID-04 の direct プロファイル（issuer は Human IdP の Cloud Run URL、jwks_uri は JWKS バケットの公開オブジェクト URL）に対応する。

**対象要件** REQ-05-007, REQ-05-008
**前提タスク** T-RES-03
**成果物**
- `apps/resource-docs-as/src/config/trusted-idp.ts`
- `apps/resource-finance-as/src/config/trusted-idp.ts`
- `apps/resource-*-as/src/oidc/config.ts`（XAA-PATCH で `idJagConfig.trustedIdentityProviders` を差し替え）
- `apps/resource-docs-as/test/trusted-idp.spec.ts`

**実装方針**
- `trustedIdentityProviders` は1件だけにする。`issuer` は環境変数 `TRUSTED_IDP_ISSUER`、`jwksUri` は `TRUSTED_IDP_JWKS_URI` から読む。
- 起動時にどちらかが未設定なら `missing_trusted_idp_config` を出力して終了コード1で落ちる。
- 生成物の `resolveTrustedIdentityProviders` の JWKS キャッシュ（TTL 300 秒）をそのまま使う。TTL を変えない。
- 取得した JWK セットから `kid` が `idjag-` で始まる鍵だけを残して `verifyIdJagAssertion` に渡す。Human IdP の SSO 鍵（`idp-` 前置）と Resource AS 自身の鍵（`docs-as-` / `fin-as-` 前置）で ID-JAG を検証できないようにする。
- assertion の JOSE ヘッダから JWKS の取得先を組み立てる経路を作らない。`jku` `jwk` `x5u` `x5c` の拒否はライブラリ側が行うので二重実装しない。
- `TRUSTED_IDP_ISSUER` は Terraform の `platform_endpoints` オブジェクト（DEC-IAC-06）が持つ `issuer` と同じ値を Cloud Run の env として注入する。アプリ側でホスト名を組み立てない。

**完了条件**
- [ ] `apps/resource-docs-as/test/trusted-idp.spec.ts` が「JWKS の取得 URL が `TRUSTED_IDP_JWKS_URI` と一致する」ことを assert する
- [ ] `kid` が `idp-` で始まる鍵で署名した ID-JAG の提示が `invalid_grant` になるテストが緑になる
- [ ] 同一 IdP に対する連続2回の検証で JWKS の HTTP 取得が1回だけ発生することを assert するテストが緑になる
- [ ] `TRUSTED_IDP_ISSUER` 未設定で起動すると終了コード1になる

---

### T-RES-06 Resource AS の ID-JAG 受領パイプラインを固定順序で実装する

**概要**
`jwt-bearer` grant の処理を、ライブラリの合成関数ではなくステップ関数の明示的な並びで書く。
`cnf` の取り出しと isolation 判定を途中に差し込む必要があり、合成関数のままでは差し込めないためである。
REQ-08-044 が禁じる「Cloud Run IAM の通過を理由に検証をスキップする分岐」を構造として持たせない。

**対象要件** REQ-05-084, REQ-08-044
**前提タスク** T-RES-03, T-RES-05
**成果物**
- `apps/resource-docs-as/src/idjag/redeem.ts`
- `apps/resource-finance-as/src/idjag/redeem.ts`
- `apps/resource-*-as/src/oidc/routes/token.ts`（XAA-PATCH で分岐を `redeemIdJag()` 呼び出しへ置換）
- `apps/resource-docs-as/test/redeem-step-order.spec.ts`
- `apps/resource-finance-as/test/redeem-step-order.spec.ts`

**実装方針**
- `redeemIdJag(ctx)` の内部順序を次に固定する。`authorizeIdJagRedemptionClient` → `parseIdJagRedemptionParams` → `verifyIdJagAssertion` → cnf 抽出と PoP 照合（T-RES-07） → `resolveIdJagGrantScope` → 登録 scope の上限検証（T-RES-09） → `isolation_level` 検証（T-RES-19、finance のみ） → 失効済み actor の確認（T-RES-22） → Access Token 発行（T-RES-08） → ログ出力（T-RES-10）。
- `processIdJagRedemptionRequest` を呼ばない。個別のステップ関数を `@maronn-openid-connect/experimental/id-jag` から import する。
- `verifyIdJagAssertion` には `{ assertion, issuer: config.issuer, clientId: tokenClient.clientId, identityProviders }` を渡す。`issuer` は環境変数 `ISSUER` の値で、Terraform が注入した Cloud Run URL と一致する。
- ライブラリが行う検証（`typ`、`alg`、外部鍵取得ヘッダ、`iss` の信頼リスト一致、自己発行の拒否、署名、`aud` のバイト一致、`exp` と `iat` と `nbf`、`jti` と `sub` の非空、`client_id` の一致）を自前で再実装しない。
- `IdJagError` は生成物の catch 分岐がそのまま 400 で返す。この分岐を変更しない。
- `/token` は RFC 6749 §5.2 に従い、assertion 欠落を 400 `invalid_request`、検証失敗を 400 `invalid_grant` で返す。REQ-08-044 の受入条件が言う「401 と `WWW-Authenticate`」は Resource API 側（T-RES-11）で満たす。AS の token エンドポイントで 401 を返す分岐を作らない。docs 側の記述の訂正は docs 領域へ起票する。
- リクエストの呼び出し元 SA や Cloud Run のヘッダを読んで検証を分岐させるコードを書かない。

**完了条件**
- [ ] `aud` 不一致、`client_id` 不一致、`jwk` ヘッダ付きの3パターンが 400 `invalid_grant` になる統合テストが緑になる
- [ ] finance AS 宛（`aud` = finance AS の issuer）の ID-JAG を docs AS へ提示すると `invalid_grant` になり、docs AS 宛は Access Token に交換できるテストが緑になる
- [ ] Cloud Run の ID Token だけを持ち assertion を持たない POST `/token` が 400 `invalid_request` を返し、Access Token を発行しないテストが緑になる
- [ ] `redeem-step-order.spec.ts` が各ステップをスパイして上記の順序どおりに呼ばれることを assert する

---

### T-RES-07 cnf.jkt と DPoP Proof の突き合わせをクライアント認証として実装する

**概要**
Resource AS のクライアント認証を共有シークレットから `cnf.jkt` の PoP へ置き換える。
`verifyIdJagAssertion` の戻り値に `cnf` が載らないため、検証済み assertion のペイロードを再デコードして取り出す。
DEC-ID-14 と DEV-11 に対応し、REQ-05-085 の「添付確認だけで終わらせない」を満たす。

**対象要件** REQ-05-085
**前提タスク** T-RES-06
**成果物**
- `apps/resource-docs-as/src/auth/dpop-client-binding.ts`
- `apps/resource-finance-as/src/auth/dpop-client-binding.ts`
- `apps/resource-docs-as/test/client-binding.spec.ts`
- `apps/resource-finance-as/test/client-binding.spec.ts`
- `apps/resource-*-as/src/oidc/routes/token.ts`（XAA-PATCH で `validateClientAuthMethod` と `verifyClientSecret` を jwt-bearer 分岐から外す）

**実装方針**
- `bindClientByCnf(options: { assertion: string; dpopHeader: string | undefined; htu: string }): Promise<{ jkt: string }>` を実装し、次の順で fail-closed に進める。
- (1) 検証済みの assertion 文字列の2番目のセグメントを base64url デコードして JSON にする。リクエストの生パラメータを再利用しない。
- (2) `cnf` が object でない、または `cnf.jkt` が文字列でなければ `IdJagError('invalid_grant', 'The assertion is missing cnf.jkt')` を throw する。
- (3) `DPoP` ヘッダが無ければ同じ `invalid_grant` を throw する。
- (4) `packages/xaa-crypto` の `verifyDpopProof({ proof, htm: 'POST', htu, iatWindowSeconds: 60, requireAth: false })` を呼ぶ。`htu` は環境変数 `ISSUER` + `/token` の絶対 URL とし、リクエストの `Host` ヘッダから組み立てない。
- (5) `jwkThumbprint(proof.header.jwk)` と `cnf.jkt` をバイト一致で比較し、違えば `invalid_grant` を throw する。
- `jti` の重複排除は Firestore `dpop_jti/{jti}` へ `create`（既存なら失敗）で行い、TTL を iat 窓の2倍に設定する。重複時は `invalid_grant` を返し、ログの `validation_name` に `replayed_dpop_proof` を入れる。
- jwt-bearer 分岐では `validateClientAuthMethod` と `verifyClientSecret` を呼ばない。`client_id` はフォームパラメータから解決し、draft §4.4.1 の一致検証は `verifyIdJagAssertion` に委ねる。
- `agent-platform` に `clientSecret` を設定しない。Secret Manager にも置かない。
- 「DPoP ヘッダが存在するか」だけを見て通す分岐を書かない。

**完了条件**
- [ ] `apps/resource-docs-as/test/client-binding.spec.ts::rejects cnf-bearing JAG without proof / with other key / accepts matching proof` の3ケースが緑になる
- [ ] `apps/resource-finance-as/test/client-binding.spec.ts` の同名3ケースが緑になる
- [ ] `cnf` を持たない ID-JAG の提示が `invalid_grant` になるテストが緑になる
- [ ] 同一 `jti` の Proof を2回提示すると2回目が `invalid_grant` になり、ログの `validation_name` が `replayed_dpop_proof` になる

---

### T-RES-08 DPoP-bound Access Token の発行を実装する

**概要**
受領した ID-JAG から Access Token を発行し、`cnf.jkt` と `act` を payload とストアメタデータの両方へ載せる。
`token_type` を `DPoP` にし、有効期限は設定値をそのまま使う。
REQ-05-086 と DEV-12（`aud` は要素一致で判定する）に対応する。

**対象要件** REQ-05-086
**前提タスク** T-RES-07
**成果物**
- `apps/resource-docs-as/src/idjag/issue-access-token.ts`
- `apps/resource-finance-as/src/idjag/issue-access-token.ts`
- `apps/resource-*-as/src/oidc/routes/token.ts`（XAA-PATCH で `token_type` を `DPoP` に変更）
- `apps/resource-docs-as/test/access-token.spec.ts`
- `apps/resource-finance-as/test/access-token.spec.ts`

**実装方針**
- `buildAccessTokenAudience({ userInfoEndpoint: `${issuer}/userinfo`, requested: grant.requestedResources, issuer })` をそのまま使う。`aud` が2要素以上になることを前提にし、1値へ削らない。
- `buildAccessTokenPayload` の戻り値へ `act`（`grant.actor`）、`cnf: { jkt }`、finance では `isolation_level`（T-RES-19）をスプレッドで載せる。
- `createJwtAccessTokenIssuer()` を使う。`accessTokenFormat` は `'jwt'` 固定にし、opaque 分岐を残さない。ヘッダの `typ` は core が `at+jwt` にする。
- 応答の `token_type` を `'DPoP'` にする。生成物の `'Bearer'` を XAA-PATCH で置き換える。
- `expires_in` は `config.accessTokenExpiresIn`（環境変数 `ACCESS_TOKEN_EXPIRES_IN`、既定 300）を使う。ID-JAG の残存期間で cap しない。
- ストアメタデータ（`IdJagAccessTokenInfo`）へ `act`、`cnf_jkt`、`idpIssuer`、受領した ID-JAG の `jti` を保存する。T-RES-22 の一括失効がこの `act.sub` を走査する。
- refresh token と ID Token を発行しない。`offline_access` は `resolveIdJagGrantScope` が落とすので追加処理を書かない。

**完了条件**
- [ ] 発行トークンのヘッダ `typ` が `at+jwt`、payload の `cnf.jkt` が提示 Proof の thumbprint と一致、`act.sub` が `urn:xaa:agent:` で始まることを assert する統合テストが緑になる
- [ ] 応答 JSON の `token_type` が `DPoP` で、`refresh_token` と `id_token` のキーが存在しないことを assert するテストが緑になる
- [ ] `exp` が 60 秒後の ID-JAG を提示しても `expires_in` が 300 のままであることを assert するテストが緑になる
- [ ] `offline_access` を含む ID-JAG を提示しても応答 `scope` に含まれないことを assert するテストが緑になる

---

### T-RES-09 登録 scope の最小化と範囲外 scope の拒否を実装する

**概要**
各 Resource AS が `agent-platform` に許す scope を、そのリソースで必要な最小に固定する。
この値が ID-JAG 署名鍵漏洩時の被害上限になるため、起動時に宣言値を検証して逸脱したら起動しない。
RULE-52 と specs §5.0 の確定命名に対応する。

**対象要件** REQ-05-009, REQ-10-005
**前提タスク** T-RES-06
**成果物**
- `packages/xaa-contracts/src/scopes.ts`
- `apps/resource-docs-as/src/config/registered-scopes.ts`
- `apps/resource-finance-as/src/config/registered-scopes.ts`
- `tests/unit/resource/registered-scope.test.ts`
- `infra/envs/demo/variables.tf`（変数 `resource_registered_scopes`）

**実装方針**
- `packages/xaa-contracts/src/scopes.ts` に `DOCS_SCOPES = ['docs.read', 'docs.write'] as const` と `FINANCE_SCOPES = ['finance.tx.read', 'finance.tx.write'] as const` を置く。別名を作らない。
- Terraform の変数 `resource_registered_scopes`（`map(list(string))`）から Cloud Run の env `REGISTERED_SCOPES`（空白区切り）へ注入する。
- 起動時に `REGISTERED_SCOPES` をパースし、対応する定数と集合として一致しなければ `invalid_registered_scope` を出力して終了コード1で落ちる。`*` と `admin` を含む値もここで落ちる。
- `resolveIdJagGrantScope` の結果に登録 scope 外の値が1つでもあれば `IdJagError('invalid_scope', ...)` を throw する。
- REQ-10-005 の例示（`finance.transaction.read`、`docs.document.read`、`docs.document.write`）と REQ-05-009 の「finance は読み取り1種」は specs §5.0 で破棄済みの別名と件数である。finance は `finance.tx.read` と `finance.tx.write` の2件で確定する。
- ワイルドカードを展開する処理と、実行時に登録 scope を書き換える処理を作らない。

**完了条件**
- [ ] `tests/unit/resource/registered-scope.test.ts` が docs 2件、finance 2件であり、`*` と `admin` を含まないことを assert する
- [ ] `finance.admin` を含む ID-JAG の交換が `invalid_scope` になるテストが緑になる
- [ ] `REGISTERED_SCOPES="docs.read docs.admin"` で起動すると終了コード1になるテストが緑になる
- [ ] ID-JAG の `scope` が `docs.read` だけのとき、応答 `scope` も `docs.read` だけになる

---

### T-RES-10 Resource AS の受領ログ12項目を出力する

**概要**
ID-JAG の受領について、正常時と拒否時の両方で同じ項目を構造化ログへ出す。
`jti` と `kid` と `typ` は Agent OP の発行台帳との突合キーになるため必須にする。
REQ-09-011 と RULE-38（生トークンを残さない）に対応する。

**対象要件** REQ-09-011
**前提タスク** T-RES-08
**成果物**
- `apps/resource-docs-as/src/log/as-log.ts`
- `apps/resource-finance-as/src/log/as-log.ts`
- `tests/e2e/specs/resource/finance-as-log.spec.ts`
- `tests/e2e/specs/resource/docs-as-log.spec.ts`

**実装方針**
- `logIdJagRedemption(entry)` を1関数だけ export し、次の12項目を必ず含める。`idjag_iss`, `idjag_sub`, `idjag_act_sub`, `idjag_client_id`, `idjag_jti`, `idjag_kid`, `idjag_typ`, `audience`, `resource`, `scope`, `cnf_jkt_match`, `token_issued`。
- 加えて `authorization_decision`（`allow` または `deny:<error_code>`）と `validation_name` を出す。
- 署名検証より前に落ちた場合でも、ヘッダとペイロードのデコードで取れる `idjag_jti` `idjag_kid` `idjag_typ` は出す。取れない項目は `null` にし、キー自体を落とさない。
- `assertion` の生文字列、発行した Access Token の生文字列、DPoP Proof の生文字列をログに入れない。`cnf_jkt` は公開値なので thumbprint をそのまま出してよい。
- 出力は `packages/gcp` の共通ロガー `logStructured(payload)` 経由に限る（T-SEC-07 の静的検査対象）。`console.log` を直接呼ばない。

**完了条件**
- [ ] `tests/e2e/specs/resource/finance-as-log.spec.ts` が正常受領と cnf 不一致拒否の2経路で12項目の存在を assert する
- [ ] `tests/e2e/specs/resource/docs-as-log.spec.ts` が同じ2経路で12項目の存在を assert する
- [ ] ログ JSON を文字列化して assertion と access_token の値が部分文字列として現れないことを assert するテストが緑になる
- [ ] 署名検証失敗の経路でも `idjag_jti` と `idjag_kid` と `idjag_typ` が非 null で出る

---

### T-RES-11 Resource API 共通の保護ミドルウェアを作る

**概要**
2つの Resource API が同じ手順で Access Token と DPoP Proof を検証するよう、共通パッケージへ切り出す。
`sub` と `act.sub` の両方が判別できないトークンを 401 にし、scope 不足を 403 にする。
REQ-08-044 の「IAM 通過を理由に検証をスキップしない」を、分岐を持たない実装で満たす。

**対象要件** REQ-01-017, REQ-05-087, REQ-05-088, REQ-08-044
**前提タスク** T-RES-08
**成果物**
- `packages/xaa-resource-guard/package.json`
- `packages/xaa-resource-guard/src/index.ts`
- `packages/xaa-resource-guard/src/protect.ts`
- `packages/xaa-resource-guard/src/access-token.ts`
- `packages/xaa-resource-guard/src/errors.ts`
- `packages/xaa-resource-guard/test/protect.spec.ts`
- `apps/resource-docs-api/src/middleware/protect.ts`
- `apps/resource-finance-api/src/middleware/protect.ts`

**実装方針**
- 新規パッケージ `@xaa/resource-guard` を作る。DEC-APP-03 の「2つ目のアプリが import したくなった時点で切り出す」に該当する（`resource-docs-api` と `resource-finance-api` の2アプリが使う）。Control Plane 側の保護ミドルウェアはこのパッケージに含めない。
- `createResourceProtection(options: { asIssuer: string; resourceUri: string; jwksUrl: string; requiredScopes: (c) => string[] })` が Hono の `MiddlewareHandler` を返す。
- 検証順序を次に固定する。(1) `Authorization` が `DPoP <token>` 形式か (2) JWKS から `kid` 一致鍵で ES256 署名検証 (3) ヘッダの `typ === 'at+jwt'` (4) `iss === asIssuer` (5) `aud` 配列に `resourceUri` が要素として含まれるか (6) `exp` と `nbf` と `iat`（leeway 60 秒） (7) `sub` と `act.sub` がともに非空文字列 (8) 失効済み actor でないこと（T-RES-22） (9) DPoP Proof 検証（`htm`、`htu`、iat 窓、`jti` 重複、`ath` が Access Token の SHA-256 base64url と一致、Proof の jwk thumbprint が `cnf.jkt` と一致） (10) scope 判定。
- (1) から (9) の失敗は 401、(10) の不足は 403 `insufficient_scope`。
- `aud` は要素一致でのみ判定する。`startsWith` と `includes`（部分文字列）を使わない（DEV-12）。
- 401 の応答に `WWW-Authenticate: DPoP error="invalid_token"` と `WWW-Authenticate: Bearer error="invalid_token"` の2ヘッダを併記する。REQ-08-044 が要求する Bearer 形式の challenge をこれで満たす。
- `sub` だけ、または `act` だけのトークンは 401 `invalid_token` にする（REQ-01-017）。403 にしない。
- 呼び出し元 SA、`X-Forwarded-*`、Cloud Run の ID Token を読んで検証を短絡する分岐を書かない。Cloud Run の ID Token を `Authorization` に見つけた場合は (3) の `typ` 検査で 401 になる。
- 検証結果を `c.set('xaa', { humanSubject, agentId, scopes, isolationLevel, constraints })` に載せ、各ルートはここからだけ主体を読む。

**完了条件**
- [ ] 正しい Cloud Run ID Token だけを持ち ID-JAG 由来 Access Token を持たない要求が docs API と finance API の両方で 401 になり、`WWW-Authenticate` が2本返るテスト2件が緑になる
- [ ] `act` を欠いた Access Token、`sub` を欠いた Access Token がともに 401 `invalid_token` になるテストが緑になる
- [ ] Proof 無し、別鍵の Proof、`ath` 不一致の3ケースが 401 になるテストが緑になる
- [ ] `docs.read` だけのトークンで書き込み系ルートを呼ぶと 403 `insufficient_scope` になるテストが緑になる
- [ ] `aud` が `https://resource-docs-api-x/extra` のような接頭辞違いでは通らないテストが緑になる

---

### T-RES-12 Resource API のアクセスログ7項目を出力する

**概要**
2つの Resource API が API 呼び出しごとに同じ7項目を出す。
加えて ID-JAG 由来の `human_subject` と `agent_id` を必ず併記し、「誰の代理でどの Agent が操作したか」を1行で追えるようにする。
REQ-09-012 と REQ-01-017 に対応する。

**対象要件** REQ-09-012, REQ-01-017
**前提タスク** T-RES-11
**成果物**
- `packages/xaa-resource-guard/src/api-log.ts`
- `apps/resource-docs-api/src/middleware/access-log.ts`
- `apps/resource-finance-api/src/middleware/access-log.ts`
- `tests/e2e/specs/resource/api-log.spec.ts`

**実装方針**
- `logApiAccess({ tool_id, operation, method, resource, status, outcome, latency_ms, human_subject, agent_id })` を1関数で提供する。
- `tool_id` はリクエストヘッダ `X-XAA-Tool-Id` から受け取る。Tool Catalog に無い値なら `unknown` として記録し、処理は続ける。この値を認可判断に使わない。
- `operation` はルート定義に静的に紐づけた文字列（`document.list`、`document.get`、`document.create`、`document.update`、`payment.list`、`payment.get`、`payment.approve`）を使う。パスから機械的に導出しない。
- `resource` は自 API の絶対 URI（環境変数 `RESOURCE_URI`）を使う。
- `outcome` は `success` または `error:<code>`（例 `error:insufficient_scope`）にする。
- `latency_ms` はミドルウェア入口で `performance.now()` を取り、応答生成後に差分を整数で出す。
- 401 と 403 の経路でも同じ7項目を出す。主体が取れない 401 では `human_subject` と `agent_id` を `null` にする。
- Google API 呼び出しの代替記録（`source=agent-runtime`, `proxied_for=google`）は Tool Executor 側（T-RUN-14）が持つ。本タスクでは実装しない。
- 出力は `logStructured` 経由に限る。

**完了条件**
- [ ] `tests/e2e/specs/resource/api-log.spec.ts` が docs の読み1回と書き1回、finance の1回、計3行について7項目と `human_subject` と `agent_id` を assert する
- [ ] 403 の応答でも同じ7項目が `outcome=error:insufficient_scope` で出ることを assert する
- [ ] Access Token と DPoP Proof の生文字列がログ JSON に現れないことを assert する
- [ ] `X-XAA-Tool-Id` に未登録の値を入れても応答ステータスが変わらず、ログの `tool_id` が `unknown` になる

---

### T-RES-13 Document のデータモデルと Firestore コレクションを作る

**概要**
`documents/{document_id}` の構造を固定し、日報や業務記録やメールなど6ソースを `type` で区別する。
所有者はトークンの `sub` から決め、リクエストボディから受け取らない。
specs §5.1 のデータ定義と REQ-02-019 に対応する。

**対象要件** REQ-02-019
**前提タスク** T-RES-02
**成果物**
- `packages/xaa-contracts/schema/document.schema.json`
- `packages/xaa-contracts/src/document.ts`
- `apps/resource-docs-api/src/store/documents.ts`
- `apps/resource-docs-api/test/documents-store.spec.ts`
- `infra/envs/demo/firestore.tf`（`documents` の複合インデックス）

**実装方針**
- フィールドは `document_id`, `owner_subject`, `type`, `title`, `body`, `occurred_at`, `metadata`, `created_at`, `updated_at`, `version` の10個に固定する。
- `type` の enum は `daily_report`, `work_log`, `mail`, `calendar`, `chat`, `note`, `task` の7値。
- `document_id` は `doc_` + UUID v4。クライアントから受け取らずサーバで採番する。
- `owner_subject` は Access Token の `sub`。リクエストボディに同名キーがあっても無視する（Ajv の `additionalProperties: false` により入力スキーマに存在させない）。
- `version` は作成時 1、更新のたびに +1。
- スキーマは JSON Schema を正とし、TypeScript 型は `json-schema-to-ts` で導出する。検証は Ajv（strict、`additionalProperties: false`）。
- 複合インデックスは `(owner_subject asc, type asc, occurred_at desc)` を Terraform で定義する。手動作成に依存しない。
- 外部 SaaS からの取り込み（`WorkSignalSource` の別実装）を本タスクで実装しない。

**完了条件**
- [ ] 未定義フィールドを含む入力が Ajv で拒否されるユニットテストが緑になる
- [ ] リクエストボディに `owner_subject` を入れても保存値がトークンの `sub` になるテストが緑になる
- [ ] `type` に enum 外の値を入れると 400 になるテストが緑になる
- [ ] `terraform validate` が `documents` の複合インデックス定義を通す

---

### T-RES-14 Document API 4本を実装する

**概要**
文書の一覧、取得、作成、更新の4エンドポイントを実装する。
`docs.read` だけの Access Token による書き込みは 403 とし、更新は `version` の楽観ロックで競合を 409 にする。
REQ-02-019 と REQ-05-088 に対応する。

**対象要件** REQ-02-019, REQ-05-088
**前提タスク** T-RES-11, T-RES-13
**成果物**
- `apps/resource-docs-api/src/app.ts`
- `apps/resource-docs-api/src/routes/documents.ts`
- `packages/xaa-contracts/schema/document-create.schema.json`
- `packages/xaa-contracts/schema/document-patch.schema.json`
- `apps/resource-docs-api/test/documents.spec.ts`
- `tests/e2e/specs/resource/docs-api.spec.ts`

**実装方針**
- `GET /documents?type=&from=&to=&limit=` は scope `docs.read`。`owner_subject == sub` で絞り、`document_id` と `type` と `title` と `occurred_at` だけを返す。`body` を返さない。`limit` は既定 20、最大 100、超過は 400。
- `GET /documents/{id}` は scope `docs.read`。`body` 込みで返す。他人の文書は 404（403 にしない。存在の有無を漏らさない）。
- `POST /documents` は scope `docs.write`。201 と `{"document_id": "doc_..."}` を返す。
- `PATCH /documents/{id}` は scope `docs.write`。更新できるのは `title` と `body` だけ。ボディに `version` を必須にし、保存値と一致しなければ 409 `version_conflict`。一致すれば `version` を +1 し `updated_at` を更新する。
- 更新は Firestore の `runTransaction` で読みと書きを1トランザクションにする。
- REQ-05-088 が言う PUT は作らない。更新は PATCH に統一する（specs §5.1）。
- `docs.read` だけのトークンによる POST と PATCH は T-RES-11 の scope 判定で 403 `insufficient_scope` になる。ルート側で重複判定しない。

**完了条件**
- [ ] `docs.read` のみの Access Token で PATCH が 403、GET が 200 になる e2e テストが緑になる
- [ ] `version` 不一致の PATCH が 409 `version_conflict` を返し、保存値が変わらないテストが緑になる
- [ ] 他ユーザーの `document_id` への GET が 404 になるテストが緑になる
- [ ] 一覧応答の各要素に `body` キーが存在しないことを assert するテストが緑になる

---

### T-RES-15 Document の Tool と Connector を seed する

**概要**
Tool Catalog に Document 用の4 Tool と1 Connector を登録する。
Tool ID と required_capability と response_schema の allowlist を specs §5.1 の表どおりに固定する。
RULE-15（Capability と Tool の分離）と RULE-16（接続先情報は Catalog が持つ）に対応する。

**対象要件** REQ-02-019
**前提タスク** T-RES-14
**成果物**
- `scripts/seed/tools-docs.json`
- `scripts/seed/connectors-docs.json`
- `packages/xaa-contracts/src/tool-ids.ts`（`internal.document.*` の定数追加）
- `tests/unit/resource/tool-catalog-docs.test.ts`

**実装方針**
- Tool は `internal.document.list`（`document.read` / GET `/documents` / `docs.read`）、`internal.document.get`（`document.read` / GET `/documents/{document_id}` / `docs.read`）、`internal.document.create`（`document.write` / POST `/documents` / `docs.write`）、`internal.document.update`（`document.write` / PATCH `/documents/{document_id}` / `docs.write`）の4件。
- `response_schema` の allowlist は list が `document_id, type, title, occurred_at`、get がそれに `body` を加えた5件、create が `document_id, type, title`、update が `document_id, version, updated_at`。
- Connector は `internal-docs-api` の1件。`resource_type=native_xaa`、`risk_level=medium`、接続先は `platform_endpoints` の `resource_docs_api_url` を参照する。
- Capability Taxonomy への `document.read` と `document.write` の登録は T-AUTHZ-06 が持つ。ここで重複登録しない。
- 破棄した別名（`docs.document.get`、`docs.document.update`、`document.content.read`、`document.content.write`）を書かない。
- 命名規約の検証は T-AUTHZ-06 の検証関数を import して再利用する。同等の関数を新規に書かない。

**完了条件**
- [ ] seed 実行後に `catalog/tools` へ `internal.document.list`、`internal.document.get`、`internal.document.create`、`internal.document.update` の4件が存在する
- [ ] `tests/unit/resource/tool-catalog-docs.test.ts` が破棄した別名の不在を assert する
- [ ] 各 Tool の `response_schema` の allowlist キー集合が specs §5.1 の表と一致することを assert する
- [ ] `catalog/connectors` の `internal-docs-api` が `resource_type=native_xaa` かつ `risk_level=medium` である

---

### T-RES-16 Finance のデータモデルと Firestore コレクションを作る

**概要**
`payments/{payment_id}` の構造を固定する。
承認の主体を記録する3フィールド（`approved_by`, `approved_by_agent`, `approved_at`）を API から直接書けない位置に置く。
specs §5.2 のデータ定義と REQ-02-018 に対応する。

**対象要件** REQ-02-018
**前提タスク** T-RES-02
**成果物**
- `packages/xaa-contracts/schema/payment.schema.json`
- `packages/xaa-contracts/src/payment.ts`
- `apps/resource-finance-api/src/store/payments.ts`
- `scripts/seed/payments-demo.json`
- `apps/resource-finance-api/test/payments-store.spec.ts`

**実装方針**
- フィールドは `payment_id`, `requester_subject`, `amount`, `currency`, `counterparty`, `status`, `memo`, `approved_by`, `approved_by_agent`, `approved_at`, `created_at` に固定する。
- `payment_id` は `pay_` + UUID v4。
- `amount` は最小単位の整数。小数と文字列を受け付けない（JSON Schema で `type: integer`, `minimum: 1`）。
- `currency` は `JPY` の1値のみ許す。
- `status` の enum は `pending_approval`, `approved`, `rejected`, `executed`。初期値は `pending_approval`。
- `approved_by`、`approved_by_agent`、`approved_at` は書き込み用の入力スキーマに含めない。承認処理（T-RES-21）だけが書く。
- デモ用の支払データは seed で投入する。Resource API に作成エンドポイントを設けない（specs §5.2 の API 表に無い）。
- 複合インデックス `(requester_subject asc, status asc, created_at desc)` を `infra/envs/demo/firestore.tf` に定義する。

**完了条件**
- [ ] `amount` に小数または0以下を入れると Ajv が拒否するユニットテストが緑になる
- [ ] 入力スキーマに `approved_by` が存在しないことを assert するテストが緑になる
- [ ] seed 実行後に `payments` へ `pending_approval` のレコードが投入される
- [ ] `terraform validate` が `payments` の複合インデックス定義を通す

---

### T-RES-17 Finance API 3本を実装し approve を冪等にする

**概要**
支払の一覧、取得、承認の3エンドポイントを実装する。
承認は同じリクエストを2回受けても結果が変わらない冪等な操作にする。
REQ-02-018 と REQ-05-087 に対応する。

**対象要件** REQ-02-018, REQ-05-087
**前提タスク** T-RES-11, T-RES-16
**成果物**
- `apps/resource-finance-api/src/app.ts`
- `apps/resource-finance-api/src/routes/payments.ts`
- `apps/resource-finance-api/test/payments.spec.ts`
- `tests/e2e/specs/resource/finance-api.spec.ts`

**実装方針**
- `GET /payments?status=&limit=` は scope `finance.tx.read`。`requester_subject == sub` で絞る。`limit` は既定 20、最大 100。
- `GET /payments/{id}` は scope `finance.tx.read`。他人のレコードは 404。
- `POST /payments/{id}/approve` は scope `finance.tx.write`。`runTransaction` で `pending_approval` → `approved` に遷移させる。
- 既に `approved` の場合は 200 と `{"payment_id": ..., "status": "approved", "result": "already_approved"}` を返す。エラーにしない。
- `rejected` と `executed` からの承認は 409 `invalid_state` を返す。
- `finance.tx.read` だけのトークンによる approve は T-RES-11 の scope 判定で 403 になる。ルート側で重複判定しない。
- 承認時の主体記録は T-RES-21、金額上限の検証は T-RES-20、isolation の検証は T-RES-19 が担当する。本タスクでは状態遷移と冪等性だけを実装する。

**完了条件**
- [ ] `finance.tx.read` のトークンで approve を呼ぶと 403、`finance.tx.write` では 200 になる e2e テストが緑になる
- [ ] 同じ payment への approve を2回呼ぶと2回目が 200 と `already_approved` を返し、`approved_at` が変わらないテストが緑になる
- [ ] `executed` の payment への approve が 409 `invalid_state` になるテストが緑になる
- [ ] 他ユーザーの `payment_id` への GET が 404 になるテストが緑になる

---

### T-RES-18 Finance の Tool と Connector と Resource Sensitivity を seed する

**概要**
Tool Catalog に Finance 用の3 Tool と1 Connector を登録し、承認 Tool に `max_amount` の constraint 枠を持たせる。
Risk Policy が金融操作を FULL_ISOLATION と判定するための入力値（Resource Sensitivity）も併せて投入する。
REQ-02-018 と RULE-12（Isolation Level は Policy Engine が決める）に対応する。

**対象要件** REQ-02-018
**前提タスク** T-RES-17
**成果物**
- `scripts/seed/tools-finance.json`
- `scripts/seed/connectors-finance.json`
- `scripts/seed/resource-sensitivity.json`
- `packages/xaa-contracts/src/tool-ids.ts`（`internal.finance.payment.*` の定数追加）
- `tests/unit/resource/tool-catalog-finance.test.ts`

**実装方針**
- Tool は `internal.finance.payment.list`（`finance.payment.read` / GET `/payments` / `finance.tx.read`）、`internal.finance.payment.get`（`finance.payment.read` / GET `/payments/{payment_id}` / `finance.tx.read`）、`internal.finance.payment.approve`（`finance.payment.approve` / POST `/payments/{payment_id}/approve` / `finance.tx.write`）の3件。
- `internal.finance.payment.approve` の `constraints` に `max_amount` のキーを宣言する。値は Policy Engine の `added_constraint` が Manifest 生成時に埋めるため、seed では既定値だけを置く。
- Connector は `internal-finance-api` の1件。`resource_type=native_xaa`、`risk_level=high`。
- Resource Sensitivity は `{"resource_id": "internal-finance-api", "sensitivity": "high"}` を投入する。docs 側には加点を置かない。
- Risk Policy のルール本体（`financial_operation = true` → `min_isolation_level = full_isolation`、risk_score に関わらず降格しない）は T-AUTHZ-09 が持つ。ここでルールを二重定義しない。
- 破棄した別名（`finance.payment.get`、`finance.payment.approve` を Tool ID として使う形、`transactions.read`、`transfers.write`）を書かない。

**完了条件**
- [ ] seed 実行後に `catalog/tools` へ `internal.finance.payment.list`、`internal.finance.payment.get`、`internal.finance.payment.approve` の3件が存在する
- [ ] `internal.finance.payment.approve` の `constraints` に `max_amount` キーが存在することを assert するテストが緑になる
- [ ] `catalog/connectors` の `internal-finance-api` が `risk_level=high` である
- [ ] `tests/unit/resource/tool-catalog-finance.test.ts` が破棄した別名の不在を assert する

---

### T-RES-19 Finance の isolation_level 検証を実装する

**概要**
金融側は、Agent が完全隔離で動いている場合しか受け付けない。
判定は ID-JAG の `isolation_level` クレームで行い、Resource AS の受領時と Resource API の受信時の2箇所で確認する。
REQ-01-018 と REQ-08-044 の「IAM 通過を理由にスキップしない」に対応する。

**対象要件** REQ-01-018, REQ-08-044
**前提タスク** T-RES-06, T-RES-11
**成果物**
- `apps/resource-finance-as/src/idjag/isolation.ts`
- `apps/resource-finance-as/src/idjag/redeem.ts`（ステップの差し込み）
- `apps/resource-finance-api/src/middleware/isolation.ts`
- `apps/resource-finance-as/test/isolation.spec.ts`
- `apps/resource-finance-api/test/isolation.spec.ts`
- `tests/e2e/specs/resource/finance-isolation.spec.ts`

**実装方針**
- `isolation_level` は `verifyIdJagAssertion` の戻り値に載らないため、`cnf` と同じ経路で検証済み assertion のペイロードを再デコードして取り出す。
- 値が `full_isolation` 以外、または欠落、または文字列でない場合は 403 と `{"error":"insufficient_isolation"}` を返す。`invalid_grant` にしない。
- Resource AS の 403 は `IdJagError` では表現できないため、`ResourceAsError(status: number, code: string)` を `apps/resource-finance-as/src/errors.ts` に定義し、`routes/token.ts` の catch へ XAA-PATCH で分岐を1つ追加する。
- Resource AS は Access Token の payload へ `isolation_level` を引き継ぐ（T-RES-08）。
- Resource API は T-RES-11 の検証を通過した後、`c.get('xaa').isolationLevel` が `full_isolation` でなければ 403 `insufficient_isolation` を返す。AS で検査済みであることを理由に省略しない。
- docs 側の AS と API はこの検証を持たない。共通パッケージへ入れず、finance の2アプリにだけ置く。
- 呼び出し元 SA がスロット専用 SA であること、Cloud Run IAM を通過したことを理由に検証を飛ばす分岐を書かない。

**完了条件**
- [ ] `isolation_level=standard` の ID-JAG の受領が finance AS で 403 `insufficient_isolation` になるテストが緑になる
- [ ] `isolation_level` を欠いた ID-JAG も 403 `insufficient_isolation` になるテストが緑になる
- [ ] `full_isolation` の Agent では Access Token が発行され、その payload に `isolation_level` が載り、`POST /payments/{id}/approve` が 200 になる e2e テストが緑になる
- [ ] `isolation_level` を書き換えた（署名し直していない）Access Token が finance API で 401 になるテストが緑になる
- [ ] docs AS の受領パイプラインに isolation 判定のステップが無いことを step-order テストで固定する

---

### T-RES-20 max_amount の constraint を Resource API の受信時に検証する

**概要**
承認金額の上限を、Tool Executor の事前検証（T-RUN-10）とは独立に Resource API 側でも確認する。
Executor を通さずに API を直接叩いても上限が効く状態にする。
specs §5.2 の「constraint の二重検証」に対応する。

**対象要件** REQ-02-018
**前提タスク** T-RES-17, T-RES-19
**成果物**
- `apps/resource-finance-api/src/middleware/constraints.ts`
- `apps/resource-finance-as/src/idjag/constraints.ts`
- `apps/resource-finance-api/test/constraints.spec.ts`
- `tests/e2e/specs/resource/finance-constraint.spec.ts`
- `infra/envs/demo/variables.tf`（変数 `finance_absolute_max_amount`）

**実装方針**
- Resource AS は、検証済み assertion のペイロードに `constraints` オブジェクトがあれば、そのうち `internal.finance.payment.approve` のエントリだけを取り出し、Access Token の payload へ `xaa_constraints` として引き継ぐ。それ以外のキーは落とす。
- Resource API は `POST /payments/{id}/approve` の処理前に2段階で判定する。(1) `xaa_constraints.max_amount` が数値なら `payment.amount <= max_amount` を確認する。(2) 常に `payment.amount <= FINANCE_ABSOLUTE_MAX_AMOUNT`（環境変数、Terraform 変数 `finance_absolute_max_amount` から注入）を確認する。
- `xaa_constraints` が無い Access Token でも (2) は必ず走る。上限なしとして通す分岐を作らない。
- 違反時は 403 と `{"error":"constraint_violation","limit_source":"token"|"server"}` を返し、`payments` を書き換えない。
- 検証は状態遷移トランザクションの外側、ミドルウェアで行う。トランザクション内で例外を投げて巻き戻す方式にしない。
- Tool Executor 側の事前検証（`constraint_violation` を返して外部通信を行わない）は T-RUN-10 が持つ。ここでは実装しない。

**完了条件**
- [ ] `xaa_constraints.max_amount` を超える金額の approve が 403 `constraint_violation` になり、`payments` の `status` が `pending_approval` のまま変わらないテストが緑になる
- [ ] `xaa_constraints` を持たない Access Token でも `finance_absolute_max_amount` 超過が 403 になるテストが緑になる
- [ ] 上限内の金額では 200 で承認されるテストが緑になる
- [ ] Tool Executor を経由せず `resource-finance-api` へ直接リクエストしても上限が効くことを統合テストで確認する

---

### T-RES-21 承認の二重の主体記録を実装する

**概要**
支払の承認レコードに、委譲元の人間（`approved_by`）と代理で動いた Agent（`approved_by_agent`）の両方を残す。
応答と監査ログの両方に出し、Resource 側の1レコードで委譲関係を追えるようにする。
RULE-46 と specs §5.2 の「二重の主体記録」に対応する。

**対象要件** REQ-01-018, REQ-09-012
**前提タスク** T-RES-17, T-RES-12
**成果物**
- `apps/resource-finance-api/src/routes/payments.ts`（approve の書き込み部）
- `apps/resource-finance-api/src/log/approval-log.ts`
- `apps/resource-finance-api/test/approval-subjects.spec.ts`
- `tests/e2e/specs/resource/finance-approval-subject.spec.ts`

**実装方針**
- 承認成功時に `approved_by = c.get('xaa').humanSubject`（ID-JAG の `sub`）、`approved_by_agent = c.get('xaa').agentId`（ID-JAG の `act.sub`、`urn:xaa:agent:` 形式）、`approved_at = サーバ時刻` を書く。
- 3値ともリクエストボディからは受け取らない。入力スキーマに存在させない。
- 応答 JSON は `payment_id`, `status`, `approved_by`, `approved_by_agent`, `approved_at` の5キーを返す。
- 監査ログは `logApiAccess` の7項目に加えて `approved_by` と `approved_by_agent` と `payment_id` と `amount` を出す。
- 型は `approved_by: string` と `approved_by_agent: string` を必須にする。片方しか無いトークンは T-RES-11 が 401 で落とすため、`null` が入る経路を型として持たない。
- `already_approved` の応答でも、既存レコードの `approved_by` と `approved_by_agent` をそのまま返す。空にしない。

**完了条件**
- [ ] 承認後の `payments` レコードに `approved_by` と `approved_by_agent` の両方が非空で入ることを assert する e2e テストが緑になる
- [ ] 応答 JSON に5キーが揃っていることを assert するテストが緑になる
- [ ] 監査ログの1行に `approved_by` と `approved_by_agent` の両方が出ることを assert するテストが緑になる
- [ ] リクエストボディに `approved_by` を入れても保存値がトークンの `sub` になるテストが緑になる
- [ ] `already_approved` の応答でも両方の主体が返ることを assert するテストが緑になる

---

### T-RES-22 act.sub 単位の一括失効を両 Resource に実装する

**概要**
Lifecycle の Cleanup から呼ばれる `/internal/revoke-by-actor` を実装し、指定した Agent が取得済みの Access Token を一括で失効させる。
Access Token は JWT なので、失効は失効台帳を引く形で強制する。
specs §5.1 と §5.2 の API 表、および「act.sub 単位の一括失効」に対応する。

**対象要件** REQ-07-021（呼び出し元は T-LIFE-04。本タスクは受領側）
**前提タスク** T-RES-11, T-RES-08
**成果物**
- `apps/resource-docs-api/src/routes/internal-revoke.ts`
- `apps/resource-finance-api/src/routes/internal-revoke.ts`
- `packages/xaa-resource-guard/src/revocation.ts`
- `apps/resource-docs-as/src/idjag/revocation-check.ts`
- `apps/resource-finance-as/src/idjag/revocation-check.ts`
- `apps/resource-docs-api/test/internal-revoke.spec.ts`
- `tests/e2e/specs/resource/revoke-by-actor.spec.ts`

**実装方針**
- エンドポイントは `POST /internal/revoke-by-actor`、ボディは `{"act_sub":"urn:xaa:agent:<agent_id>"}` の1キーのみ。Ajv で `additionalProperties: false`。
- 認証は Cloud Run の OIDC ID Token を検証し、`email` が環境変数 `LIFECYCLE_SA_EMAIL` と一致する場合だけ許可する。不一致は 403。DPoP は要求しない。
- 処理は `revoked_actors/{base64url(act_sub)}` に `{ act_sub, revoked_at }` を `create` で書く。既存なら `revoked_at` を更新せず 200 を返す（冪等）。
- `packages/xaa-resource-guard/src/revocation.ts` に `isActorRevoked(actSub, tokenIat)` を置き、`revoked_actors` を 10 秒キャッシュで引く。`revoked_at <= tokenIat` でなければ失効とみなし、T-RES-11 の手順(8)で 401 `token_revoked` を返す。
- Resource AS は受領パイプラインで同じ台帳を引き、失効済み `act.sub` の ID-JAG は `invalid_grant` にする。失効後に新しい Access Token を取り直せないようにする。
- 失効台帳は docs と finance で共通の1コレクションにする。リソースごとに分けない。
- 存在しない `act_sub` を指定されても 200 を返す。404 にしない。
- Resource AS 側にこのエンドポイントを置かない。書き込みは Resource API の1経路だけにする。

**完了条件**
- [ ] `sa-lifecycle` 以外の SA の ID Token による呼び出しが 403 になるテストが緑になる
- [ ] 失効後、同じ Access Token での `GET /documents` がキャッシュ TTL 経過後に 401 `token_revoked` になる e2e テストが緑になる
- [ ] 失効後、同じ ID-JAG の再提示が Resource AS で `invalid_grant` になるテストが緑になる
- [ ] 同じ `act_sub` に2回呼んでも 200 で `revoked_at` が変化しないテストが緑になる
- [ ] 未知の `act_sub` への呼び出しが 200 を返すテストが緑になる

---

### T-RES-23 Resource 2種の統合テストと negative テストを固定する

**概要**
この領域が満たす検証を、テスト名まで含めて固定する。
逸脱一覧（DEV-04, DEV-09, DEV-11, DEV-12）の「固定するテスト」列が指すテストをここで揃え、`docs:deviations` の CI 判定が通る状態にする。
DEC-APP-07 の統合テスト方式（同一プロセスで `app.fetch` を呼ぶ）に従う。

**対象要件** REQ-05-084, REQ-05-085, REQ-05-086, REQ-05-087, REQ-05-088, REQ-08-044
**前提タスク** T-RES-14, T-RES-17, T-RES-19, T-RES-20, T-RES-21, T-RES-22
**成果物**
- `tests/integration/resource/harness.ts`
- `tests/integration/resource/docs-flow.spec.ts`
- `tests/integration/resource/finance-flow.spec.ts`
- `tests/integration/resource/negative.spec.ts`
- `packages/xaa-contracts/test/audience.spec.ts`

**実装方針**
- ハーネスは `agent-op`、`human-idp`、`resource-docs-as`、`resource-docs-api`、`resource-finance-as`、`resource-finance-api` の `createApp()` を同一プロセスで生成し、`packages/xaa-contracts` の `httpClient` を対向の `app.fetch` へ配線する。
- 複数プロセスを起動するハーネスを作らない。ID-JAG はテスト用ヘルパで自作せず、実際の Agent OP の `/xaa/token` から取得する。
- negative テストは次を1件ずつ独立させる。ID-JAG 無し、`aud` 不一致、`client_id` 不一致、`jwk` ヘッダ付き、`cnf` 欠落、Proof 無し、別鍵 Proof、`ath` 不一致、`jti` 再送、`typ` が `at+jwt` でない、`aud` の接頭辞一致、scope 不足、`act` 欠落、`isolation_level=standard`、`max_amount` 超過、失効後の再提示。
- `packages/xaa-contracts/test/audience.spec.ts::element match, no prefix/substring match` を DEV-12 の固定テストとして置く。
- テストは Firestore エミュレータと `SIGNER_MODE=local` で動かし、GCP へ接続しない。

**完了条件**
- [ ] `pnpm test:integration -- resource` が上記16件の negative ケースを含めて緑になる
- [ ] DEV-04, DEV-09, DEV-11, DEV-12 の「固定するテスト」列に書かれたパスとテスト名が実在し、`pnpm run docs:deviations` が終了コード0になる
- [ ] 統合テストが GCP の実エンドポイントへ接続しないことを、ネットワーク遮断環境での実行で確認する
- [ ] `docs.read` のみ、`finance.tx.read` のみ、`full_isolation` あり、`standard` の4種類の Agent で経路が分岐することを1ファイル内で通しで確認する

---

## このファイルで扱わない要件

担当16件はすべて上記タスクへ割り当てた。取りこぼしは無い。
隣接領域と境界が接する項目だけを次に挙げる。

| 項目 | 扱う領域とタスク |
|---|---|
| ID-JAG への `cnf.jkt` と `isolation_level` と `constraints` の付与 | Identity（T-OP、DEC-ID-08） |
| Capability Taxonomy への `document.*` と `finance.*` の登録 | Authorization（T-AUTHZ-06） |
| Risk Policy の `financial_operation` ルールと降格禁止 | Authorization（T-AUTHZ-09） |
| Tool Executor 側の `max_amount` 事前検証 | Runtime（T-RUN-10） |
| Google API 呼び出しの代替ログ（`proxied_for=google`） | Runtime（T-RUN-14） |
| Cleanup step5 からの `/internal/revoke-by-actor` 呼び出し | Lifecycle（T-LIFE-04） |
| `packages/xaa-crypto` の DPoP 実装本体 | 共通パッケージ（DEV-01 の固定テスト） |
| REQ-08-044 の「401 と WWW-Authenticate」を docs 側の記述として訂正する作業 | ドキュメント（T-DOCS） |
