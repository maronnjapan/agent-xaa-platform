# 04. Agent OP（ID-JAG発行）（T-OP）

Agent OP は、Agent Runtime からの Token Exchange 要求を受けて ID-JAG（Identity Assertion Authorization Grant）を発行する専用サーバーである。
人間が発行した ID Token（subject_token）と、Agent 個体が自分の鍵で署名した assertion（actor_token）の2つを受け取り、両者が同じ委譲関係を指していることを照合したうえで、Resource Authorization Server 宛ての短命な grant を Cloud KMS で署名して返す。
Human IdP と同一の issuer 文字列を名乗るが、`/authorize` や discovery は持たず、`/xaa/token`、`/xaa/callback`、`/xaa/subject-token` の3経路だけを提供する。
Agent OP は判断をしない。
自然言語処理、Policy 判定、Human Permission の解決はいっさい行わず、Provisioning 時に静的注入された Agent Registration と XAA Static Configuration だけを見て、発行するか拒否するかを決める。

| 前提 | 内容 |
|---|---|
| 依存する領域 | 共通基盤（T-PKG、xaa-crypto と xaa-contracts）、インフラ（T-IAC、KMS と Firestore と Cloud Run と JWKS バケット）、Human IdP（T-IDP）、Provisioner（T-PROV）、Security Detection（T-SEC） |
| このファイルのタスク数 | 33件 |
| 主に満たす設計ルール | RULE-06, RULE-19, RULE-20, RULE-22, RULE-25, RULE-26, RULE-44, RULE-45, RULE-46, RULE-47, RULE-48, RULE-49, RULE-51, RULE-53 |

---

### T-OP-01 Agent OP の骨格と2モード起動を実装する

**概要**
Agent OP のアプリ骨格を作り、`MODE=token` と `MODE=callback` の2モードで別々の Cloud Run Service として起動できるようにする。
Cloud Run の ingress 設定はサービス単位であり、`/xaa/token` を内部限定、`/xaa/callback` を公開にするには1サービスでは満たせないため、同一イメージを環境変数で切り替える（DEC-IAC-14、REQ-08-015）。
同時に Agent OP から不要な OIDC ルートを取り除き、到達したら 404 になることを固定する（DEC-ID-03）。

**対象要件** REQ-08-015, REQ-05-026
**前提タスク** なし
**成果物**
- `apps/agent-op/package.json`
- `apps/agent-op/tsconfig.json`
- `apps/agent-op/src/index.ts`
- `apps/agent-op/src/app.ts`
- `apps/agent-op/src/config.ts`
- `apps/agent-op/src/routes/healthz.ts`
- `apps/agent-op/test/routes-mounted.spec.ts`

**実装方針**
- `apps/agent-op/src/app.ts` は `createApp(): Hono` を default export する。
  DEC-APP-07 の integration テストが `app.fetch(request)` を直接呼ぶため、`listen` は `src/index.ts` にだけ置く。
- `config.ts` で環境変数を読み、起動時に検証する。
  読む変数は `MODE`、`ISSUER`、`XAA_CLIENT_ID`（既定 `agent-platform`）、`GOOGLE_CLOUD_PROJECT`、`FIRESTORE_DATABASE`、`JWKS_BUCKET`、`JWKS_OBJECT`（既定 `jwks.json`）、`KMS_IDJAG_KEY`、`KMS_IDP_CONNECTION_KEY`、`HUMAN_IDP_AUTHORIZE_URL`、`HUMAN_IDP_TOKEN_URL`、`HUMAN_IDP_REVOKE_URL`、`ID_JAG_LIFETIME_SECONDS`（既定 300）、`SLOT_INDEX`（既定 `-1`）、`SIGNER_MODE`（`local|kms`）、`STORE_MODE`（`emulator|gcp`）の16個に限定する。
  `MODE` が `token` と `callback` のどちらでもなければ起動時に例外で落とす。
- `MODE=token` のとき `POST /xaa/token`、`POST /xaa/subject-token`、`GET /healthz` の3ルートのみをマウントする。
  `MODE=callback` のとき `GET /xaa/callback`、`GET /healthz` の2ルートのみをマウントする。
- `/authorize`、`/userinfo`、`/logout`、`/introspect`、`/revoke`、`/.well-known/openid-configuration` のハンドラを1つも定義しない。
  Hono の既定 404 に落ちる形にし、明示的な 404 ハンドラでこれらのパスを列挙しない。
- `MODE=callback` のプロセスは KMS の ID-JAG 署名鍵クライアントを初期化しない。
  初期化は `MODE=token` の分岐の中でだけ行う。
- 両モードは同じ `Dockerfile`（`--build-arg APP=agent-op`）から作った同一イメージで動く。
  モードごとのイメージを作らない。

**完了条件**
- [ ] `apps/agent-op/test/routes-mounted.spec.ts` の `MODE=callback rejects /xaa/token with 404` が緑になる。
- [ ] 同ファイルの `MODE=token rejects /xaa/callback with 404` が緑になる。
- [ ] 同ファイルの `both modes reject /authorize and /.well-known/openid-configuration with 404` が緑になる。
- [ ] `MODE` に `token` と `callback` 以外を与えて `createApp()` を呼ぶと例外になるテストが緑になる。
- [ ] `grep -rn "process.env" apps/agent-op/src --include=*.ts | grep -v src/config.ts` が0件になる。

---

### T-OP-02 Agent OP の永続データを4リポジトリに限定する

**概要**
Agent OP が参照する永続データを Issuer Profile、Agent Registration、XAA Static Configuration、Human IdP Connection の4つに限定し、Firestore アクセスをこの4リポジトリクラスへ閉じ込める（REQ-05-035）。
Agent Registration と XAA Static Configuration は docs 05 §3.4 のとおり別の型として定義する。
データストアは Firestore Native mode 1本とする（DEC-IAC-09）。

**対象要件** REQ-05-035
**前提タスク** T-OP-01
**成果物**
- `apps/agent-op/src/store/index.ts`
- `apps/agent-op/src/store/issuer-profile-repository.ts`
- `apps/agent-op/src/store/agent-registration-repository.ts`
- `apps/agent-op/src/store/xaa-config-repository.ts`
- `apps/agent-op/src/store/idp-connection-repository.ts`
- `apps/agent-op/src/store/types.ts`
- `apps/agent-op/test/store-surface.spec.ts`

**実装方針**
- Firestore のコレクション名は `agents`、`xaa_configs`、`idp_connections`、`issuer_profiles` の4つに固定する。
  この4語以外のコレクション名文字列を `apps/agent-op/src` に置かない。
- `types.ts` に4型を定義する。
  `AgentRegistration` は `agent_id`、`human_subject`、`client_auth: { method: 'client_assertion_jwt'; jwk_thumbprint: string; public_jwk: JsonWebKey }`、`idp_connection_id`、`isolation_level: 'standard' | 'full_isolation'`、`dedicated_op_slot_index: number | null`、`status: 'ACTIVE' | 'EXPIRING' | 'QUARANTINED' | 'REVOKED' | 'EXPIRED'`、`created_at`、`expires_at` を持つ。
  `XaaStaticConfiguration` は `agent_id`、`allowed_audiences: string[]`、`resources: string[]`、`scopes: string[]`、`trusted_resource_as: string[]`、`expires_at` を持つ。
  `IdpConnection` は T-OP-24 で定義する。
  `IssuerProfile` は `issuer`、`kms_key_name`、`kid` を持つ。
- 4リポジトリは `packages/gcp` の `firestore-guard` を通してのみ Firestore へ触る（DEV-05）。
  許可マトリクスに `agent-op` から到達できるパスとして上記4コレクションだけを書く。
- `store/index.ts` は4クラスと4型だけを export する。
  生の `Firestore` インスタンスを export しない。
- 書き込みは Human IdP Connection の作成と更新に限る。
  `agents` と `xaa_configs` と `issuer_profiles` は読み取り専用メソッドのみを持たせ、`set` / `update` / `delete` を実装しない。

**完了条件**
- [ ] `apps/agent-op/test/store-surface.spec.ts` の `exports exactly four repositories` が緑になる。
- [ ] 同ファイルの `agents / xaa_configs / issuer_profiles repositories expose no write method` が緑になる。
- [ ] `grep -rnoE "collection\(['\"][a-z_]+['\"]\)" apps/agent-op/src` の出力が `agents`、`xaa_configs`、`idp_connections`、`issuer_profiles` の4種のみになることを検査するテストが緑になる。
- [ ] `AgentRegistration` と `XaaStaticConfiguration` が別の型として定義され、片方をもう片方へ代入すると `tsc --noEmit` が失敗する型テストが緑になる。

---

### T-OP-03 Agent OP の責務境界を静的検査で固定する

**概要**
Agent OP が持たないものを、コメントや規約ではなくビルドで落ちる形の検査として固定する（REQ-05-036）。
外部 Registry や他 Control Plane アプリへの動的問い合わせを禁止し（REQ-05-037）、Security Detection の重い判定ロジックの import も禁止する（REQ-09-038）。
これは DEC-ID-01 と RULE-20 の「Agent OP は判断しない」を機械判定へ落とす作業である。

**対象要件** REQ-05-036, REQ-05-037, REQ-09-038
**前提タスク** T-OP-02
**成果物**
- `apps/agent-op/.eslintrc.cjs`
- `apps/agent-op/test/boundary.spec.ts`
- `scripts/check-agent-op-boundary.sh`
- `infra/tests/agent-op-roles.test.ts`

**実装方針**
- ESLint の `no-restricted-imports` に、`@google-cloud/aiplatform`、`@google-cloud/vertexai`、`@platform/security/rules`、`@platform/security/correlation`、`@platform/security/scoring`、`@platform/security/ai` の6件を禁止として書く。
  違反 fixture を `apps/agent-op/test/fixtures/forbidden-import.ts.txt` に置き、それを一時ファイルへ展開して `pnpm lint` が非ゼロ終了することをテストする。
- `scripts/check-agent-op-boundary.sh` で、`apps/agent-op/src` に他 Control Plane アプリの URL を示す環境変数名（`PROVISIONER_URL`、`AUTHORIZATION_URL`、`TOOL_CATALOG_URL`、`LIFECYCLE_URL`、`AUTOMATION_APP_URL`）が現れないことを grep で検査する。
  Agent OP から出る HTTP 宛先は Human IdP の3 URL と GCS と KMS と Firestore だけとする。
- ID-JAG 発行フローの unit テストが外部 HTTP モックを1つも張らずに完走することを、`fetch` を例外を投げる関数へ差し替えたうえで検証する。
- `infra/tests/agent-op-roles.test.ts` は `terraform plan -json` の出力を読み、`sa-shared-agent-op` に付与されるロールが `roles/cloudkms.signerVerifier`、`roles/datastore.user`、`roles/storage.objectUser`、`roles/pubsub.publisher`、`roles/logging.logWriter` の5件と完全一致することを検査する。
  `roles/aiplatform.user`、`roles/run.invoker`、`roles/secretmanager.secretAccessor` が含まれていたら失敗させる。
- 検査を落とすために例外リストを設ける実装をしない。

**完了条件**
- [ ] `apps/agent-op/test/boundary.spec.ts` の `lint fails on forbidden import fixture` が緑になる。
- [ ] `scripts/check-agent-op-boundary.sh` が終了コード0で通り、禁止環境変数名を1つ追加すると非ゼロ終了する。
- [ ] `apps/agent-op/test/boundary.spec.ts` の `issuance flow completes with fetch disabled` が緑になる。
- [ ] `infra/tests/agent-op-roles.test.ts` の `sa-shared-agent-op holds exactly the allowed five roles` が緑になる。

---

### T-OP-04 共有 JWKS の取得とキャッシュを実装する

**概要**
subject_token の署名検証に使う JWKS は Agent OP 自身の鍵ではなく、Human IdP と共有する JWKS である（REQ-05-025）。
起動時に Cloud Storage の共有 JWKS を取得してキャッシュし、`resolveIdJagSubject` の `jwks` 引数へ渡す。
DEC-ID-20 のとおり subject_token の検証に使うのは `idp-` 接頭辞の kid に限る。

**対象要件** REQ-05-025
**前提タスク** T-OP-01, T-IAC-20
**成果物**
- `apps/agent-op/src/keys/shared-jwks.ts`
- `apps/agent-op/test/shared-jwks.spec.ts`

**実装方針**
- `loadSharedJwks(): Promise<JwkSet>` と `resolveKeyByKid(kid: string): Promise<JsonWebKey | null>` を export する。
  取得元は `gs://${JWKS_BUCKET}/${JWKS_OBJECT}` の公開オブジェクトとし、HTTP の公開 URL ではなく GCS クライアントで読む。
- キャッシュ TTL は 300 秒固定とする。
  TTL 内でも要求された kid がキャッシュに無ければ即時に再取得し、再取得後も見つからなければ `null` を返す。
  再取得は 1 秒以内の連続呼び出しをまとめ、同一プロセス内で同時に2本以上の GET を出さない。
- `subjectTokenJwks(): Promise<JwkSet>` を追加し、`kid` が `idp-` で始まる鍵だけを含む `JwkSet` を返す。
  `/xaa/token` の subject_token 検証にはこれを渡し、全鍵を含む `JwkSet` を渡さない。
- 取得失敗時はキャッシュ済みの値を返さず例外にする。
  期限切れキャッシュのフォールバック利用を実装しない。
- TTL とバケット名をリクエストごとに変えられる設定を作らない。

**完了条件**
- [ ] `apps/agent-op/test/shared-jwks.spec.ts` の `refetches immediately on unknown kid` が緑になる。
- [ ] 同ファイルの `subjectTokenJwks contains only idp-prefixed kids` が緑になる。
- [ ] 同ファイルの `coalesces concurrent refetches into one GET` が緑になり、モックした GCS クライアントの呼び出し回数が1になる。
- [ ] 同ファイルの `throws instead of serving expired cache when fetch fails` が緑になる。

---

### T-OP-05 自鍵の公開鍵を共有 JWKS へ書き込む

**概要**
Agent OP は起動時と KMS 鍵バージョン更新時に、自分の ID-JAG 署名鍵の公開 JWK を共有 JWKS バケットへ書き込む（REQ-08-017）。
DEC-IAC-13 のとおり各アプリは自分専用のオブジェクト `keys/<prefix>-<kid>.json` だけを書き、`jwks.json` の集約は jwks-publish Job が行う。
これにより他アプリの kid を消す事故が構造的に起きなくなる。

**対象要件** REQ-08-017
**前提タスク** T-OP-04, T-IAC-20
**成果物**
- `apps/agent-op/src/keys/publish-public-key.ts`
- `apps/agent-op/test/publish-public-key.spec.ts`

**実装方針**
- `publishPublicKey(): Promise<void>` を export し、`MODE=token` の起動シーケンスからのみ呼ぶ。
  `MODE=callback` からは呼ばない。
- KMS の `getPublicKey` で PEM を取得し、`packages/xaa-crypto` の `pemToJwk` で `{ kty:'EC', crv:'P-256', x, y, alg:'ES256', use:'sig', kid }` へ変換する。
  秘密鍵素材を扱う経路をこの関数に持たせない。
- kid は `SLOT_INDEX < 0` のとき `op-shared-<cryptoKeyVersion の末尾番号>`、`SLOT_INDEX >= 0` のとき `op-slot-<SLOT_INDEX>-<末尾番号>` とする。
  Human IdP の `idp-` と衝突しない接頭辞にする。
- 書き込み先は `keys/<kid>.json` に固定する。
  `jwks.json` を Agent OP から書かない。
- 書き込みは `ifGenerationMatch: 0` で新規作成を試み、409 が返ったら内容を比較し、同一なら成功として扱い、異なれば現行 generation を読んで `ifGenerationMatch` 付きで上書きする。
  最大3回まで再試行し、それでも失敗したら例外にする。
- 起動時にこの処理が失敗したらプロセスを終了させる。
  署名鍵の公開鍵が JWKS に出ないまま ID-JAG を発行する状態を作らない。

**完了条件**
- [ ] `apps/agent-op/test/publish-public-key.spec.ts` の `writes only keys/<kid>.json and never jwks.json` が緑になる。
- [ ] 同ファイルの `retries with ifGenerationMatch on 409 and succeeds` が緑になる。
- [ ] 同ファイルの `startup exits non-zero when publish fails after 3 retries` が緑になる。
- [ ] `MODE=callback` で `createApp()` を起動したとき `publishPublicKey` が呼ばれないことを assert するテストが緑になる。

---

### T-OP-06 スロット専用署名鍵の kid 規約と JWKS 掲載を実装する

**概要**
FULL_ISOLATION のスロットごとに Terraform が事前作成した ID-JAG 署名鍵の公開鍵も、Shared OP の鍵と同じ共有 JWKS へ載せる（REQ-05-061）。
Resource AS は kid で Shared と Dedicated を区別せず、共有 issuer の発行物として同じに扱う。
FULL_ISOLATION が縮めるのは到達できる Registration と Refresh Token の数であり、偽造能力の広さではないことをコードとテストで固定する（DEV-07）。

**対象要件** REQ-05-061
**前提タスク** T-OP-05, T-IAC-18
**成果物**
- `apps/agent-op/src/keys/slot-key.ts`
- `apps/agent-op/test/slot-key.spec.ts`
- `e2e/test/shared-jwks-kids.spec.ts`

**実装方針**
- `resolveSigningKeyName(slotIndex: number): string` を実装する。
  `slotIndex < 0` なら `KMS_IDJAG_KEY`（Shared）、`slotIndex >= 0` なら `KMS_IDJAG_KEY` と同じ Key Ring 内の `idjag-slot-<slotIndex>` を返す。
  鍵名を実行時に組み立てるだけとし、KMS の鍵作成 API を呼ぶコードを書かない（DEC-IAC-07）。
- スロット Service には Terraform が静的 env `SLOT_INDEX` を注入する。
  Agent OP は Agent Registration の `dedicated_op_slot_index` が `SLOT_INDEX` と一致しない要求を `invalid_grant` で拒否する。
- `slot-key.ts` の先頭に、共有 JWKS へ載る以上 Dedicated 鍵で偽造できる ID-JAG の範囲は Shared 鍵と変わらない旨のコメントを置き、DEV-07 を参照する。
- スロット数は `dedicated_slot_count`（既定2）で決まる。
  アプリ側でスロット数を仮定した配列長やループ上限を書かない。

**完了条件**
- [ ] `apps/agent-op/test/slot-key.spec.ts` の `returns shared key name when SLOT_INDEX is -1` が緑になる。
- [ ] 同ファイルの `rejects registration whose dedicated_op_slot_index differs from SLOT_INDEX` が緑になり `invalid_grant` が返る。
- [ ] `e2e/test/shared-jwks-kids.spec.ts` の `jwks.json lists idp / op-shared / op-slot-0 / op-slot-1 kids` が緑になる。
- [ ] 同ファイルの `ID-JAG signed by a slot key verifies at resource-docs-as` が緑になる。

---

### T-OP-07 signIdJag を KMS 署名の唯一の入口として実装する

**概要**
ID-JAG の署名を `signIdJag` 1関数へ集約し、`typ` を引数で受け取らず関数内で `oauth-id-jag+jwt` に固定する（DEC-ID-16、REQ-10-007）。
KMS の `asymmetricSign` を呼ぶ箇所を Agent OP 全体で1件に限り、秘密鍵をプロセス内へ import する経路を持たせない（REQ-08-032）。
Agent OP から ID Token と Access Token と Request Object の発行コードを削除する（REQ-05-033）。

**対象要件** REQ-05-033, REQ-08-031, REQ-08-032, REQ-10-007
**前提タスク** T-OP-06, T-PKG-14
**成果物**
- `apps/agent-op/src/idjag/sign-id-jag.ts`
- `appsers/agent-op/test/signing-typ.spec.ts` は作らず `apps/agent-op/test/signing-typ.spec.ts`
- `scripts/check-single-asymmetric-sign.sh`

**実装方針**
- シグネチャを `signIdJag(claims: Record<string, unknown>, keyName: string, kid: string): Promise<string>` に固定する。
  `typ` と `alg` を引数に取らない。
  ヘッダは関数内で `{ alg: 'ES256', typ: 'oauth-id-jag+jwt', kid }` を組み立てる。
- 引数型を `Record<string, unknown>` にすることで、T-OP-22 が `cnf` を足した claims を cast 無しで渡せるようにする（DEC-ID-08）。
- 署名は `packages/xaa-crypto` の `kmsSignEs256(keyName, signingInput)` を使い、KMS が返す DER 署名を同パッケージの `derToJoseEs256` で raw R||S へ変換する。
  変換ロジックを Agent OP 側に複製しない。
- `createIdJagJwt`（experimental）を import しない。
  同関数は `SigningKey` の `CryptoKey` を要求するため KMS 経路と両立しない。
- Agent OP のソースから core の ID Token 発行関数と Access Token 発行関数の import を排除する。
  `scripts/check-single-asymmetric-sign.sh` で `asymmetricSign` の出現が `packages/xaa-crypto/src/kms.ts` の1件のみであること、`apps/agent-op/src` に `importPKCS8` / `importJWK` / `createPrivateKey` / `createIdJagJwt` / `issueIdToken` / `issueAccessToken` が0件であることを検査する。
- ヘッダ組み立ての直後に、組み立てた `typ` が `oauth-id-jag+jwt` であることを再確認する assert を置く。
  将来の編集で定数がすり替わった場合に KMS を呼ぶ前に落とす。

**完了条件**
- [ ] `apps/agent-op/test/signing-typ.spec.ts` の `signIdJag signature has no typ or alg parameter` が緑になる（型テストで `tsc --noEmit` が引数追加を拒否する）。
- [ ] 同ファイルの `header.typ is always oauth-id-jag+jwt` が緑になる。
- [ ] `scripts/check-single-asymmetric-sign.sh` が終了コード0で通る。
- [ ] `grep -rn "importPKCS8\|importJWK\|createPrivateKey" apps/agent-op/src` が0件になる。
- [ ] KMS クライアントを mock した状態で ES256 の raw 署名長が 64 バイトであることを assert するテストが緑になる。

---

### T-OP-08 3種類の Identity 検証関数を種別ごとに分離する

**概要**
Human Identity、Agent Identity、GCP Service Account の検証を、それぞれ別関数として実装する（REQ-01-016）。
共有 issuer と共有 JWKS の下では ID Token と Access Token と ID-JAG が同じ `iss` と JWKS に並ぶため、署名検証の直後に `typ` を検査する（DEC-ID-18）。
汎用の `verifyJwt` を各ルートから直接呼ばせない。

**対象要件** REQ-01-016
**前提タスク** T-OP-04
**成果物**
- `packages/xaa-contracts/src/verify/verify-human-access-token.ts`
- `packages/xaa-contracts/src/verify/verify-id-jag.ts`
- `packages/xaa-contracts/src/verify/verify-google-service-identity.ts`
- `packages/xaa-contracts/src/verify/index.ts`
- `packages/xaa-contracts/test/verify-separation.spec.ts`
- `scripts/check-no-raw-verify-jwt.sh`

**実装方針**
- 3関数の許容 `iss` と `typ` を関数内に固定する。
  `verifyHumanAccessToken` は `typ === 'at+jwt'` かつ `iss === ISSUER` 以外を例外にする。
  `verifyIdJag` は `typ === 'oauth-id-jag+jwt'` かつ `iss === ISSUER` 以外を例外にする。
  `verifyGoogleServiceIdentity` は `iss === 'https://accounts.google.com'` 以外を例外にする。
- 検証順序を 署名 → `typ` → `iss` → `aud` → `exp` → `nbf` に固定する。
  `typ` の検査を署名検証より前に置かない。
- 汎用の `verifyJwt` は `packages/xaa-contracts/src/verify/internal/verify-jwt.ts` に置き、`index.ts` から export しない。
- `scripts/check-no-raw-verify-jwt.sh` で、`apps/*/src/routes` 配下に `verifyJwt` の直接呼び出しが0件であることを検査する。
- 3関数は失敗理由を戻り値で区別できる形にしない。
  すべて同一の例外クラス `TokenVerificationError` を投げ、`code` は `invalid_token` 固定にする。

**完了条件**
- [ ] `packages/xaa-contracts/test/verify-separation.spec.ts` の `verifyIdJag rejects a plain ID Token with typ=JWT` が緑になる。
- [ ] 同ファイルの `verifyHumanAccessToken rejects an ID-JAG` が緑になる。
- [ ] 同ファイルの `index.ts does not export verifyJwt` が緑になる。
- [ ] `scripts/check-no-raw-verify-jwt.sh` が終了コード0で通り、ルートに `verifyJwt(` を1件足すと非ゼロ終了する。

---

### T-OP-09 client_assertion_jwt ミドルウェアを実装する

**概要**
`/xaa/token` と `/xaa/subject-token` の前段で Agent Client Credential によるクライアント認証を行う（REQ-05-041）。
maronn の client-auth は `client_secret_basic` と `client_secret_post` と `none` しか持たないため、DEC-ID-11 のとおり Agent OP の自前ミドルウェアで実装する。
これは OIDC の `private_key_jwt` とは別物であり、discovery に広告しない（DEV-02）。

**対象要件** REQ-05-041
**前提タスク** T-OP-02, T-OP-08
**成果物**
- `apps/agent-op/src/middleware/client-assertion.ts`
- `apps/agent-op/test/client-assertion.spec.ts`

**実装方針**
- ミドルウェアはフォームボディの `client_assertion_type` が `urn:ietf:params:oauth:client-assertion-type:jwt-bearer` であることを最初に確認し、違えば `invalid_client` を返す。
- `client_assertion` の JOSE ヘッダの `typ` が `agent-client-auth+jwt` でなければ `invalid_client` を返す。
  ヘッダに `jku` / `jwk` / `x5u` / `x5c` が含まれていれば署名検証へ進まず `invalid_client` を返す。
- ペイロードの `iss` と `sub` が同一で、その値が `agent-` 接頭辞を持つことを確認する。
  その値を `agent_id` とし、Agent Registration を引く。
  Registration が無ければ `invalid_client` を返す。
- 署名検証は Registration の `client_auth.public_jwk` で行い、検証後にその JWK の RFC 7638 thumbprint が `client_auth.jwk_thumbprint` と一致することを確認する。
  一致しなければ `invalid_client` を返す。
- `aud` は `${ISSUER}/xaa/token` または `${ISSUER}/xaa/subject-token` のうち、実際に到達したパスに対応する1値だけを受理する。
  `exp - iat` が 300 秒を超える assertion を拒否する。
  `jti` は TTL 360 秒のストアへ記録し、重複は `invalid_client` を返す。
- 検証順序を 形式 → `typ` → ヘッダ危険項目 → `iss`/`sub` → Registration 取得 → 署名 → thumbprint → `aud` → `exp` → `jti` に固定する。
- 検証成功後、`c.set('authenticatedAgentId', agentId)` と `c.set('agentRegistration', registration)` を置き、後段には `client_id = 'agent-platform'` を渡す（DEC-ID-22）。
  Agent ごとのクライアント登録を作らない。
- error_description は失敗理由によらず `Client authentication failed` に固定する。

**完了条件**
- [ ] `apps/agent-op/test/client-assertion.spec.ts` の `rejects missing client_assertion` が緑になる。
- [ ] 同ファイルの `rejects assertion signed with another agent key` が緑になる。
- [ ] 同ファイルの `rejects wrong typ` と `rejects jwk header` が緑になる。
- [ ] 同ファイルの `rejects replayed jti` が緑になる。
- [ ] 同ファイルの `error_description is constant across all failure modes` が緑になる。

---

### T-OP-10 /xaa/token の DPoP 検証ミドルウェアを実装する

**概要**
`/xaa/token` と `/xaa/subject-token` で DPoP Proof を必須にし、検証済み Proof の JWK の thumbprint を後段の `cnf.jkt` に使う（REQ-05-074）。
maronn は DPoP 非対応であるため、`packages/xaa-crypto` の自前実装を使う（DEV-01）。
検証順序は DEC-ID-12 のとおり固定する。

**対象要件** REQ-05-074
**前提タスク** T-OP-09, T-PKG-12
**成果物**
- `apps/agent-op/src/middleware/dpop.ts`
- `apps/agent-op/test/dpop-middleware.spec.ts`

**実装方針**
- `DPoP` ヘッダが無い要求は `invalid_dpop_proof` を返す。
  Proof を省略できる設定フラグを作らない。
- 検証は `packages/xaa-crypto` の `verifyDpopProof({ proof, htm, htu, now, jtiStore, accessTokenHash })` を呼ぶ。
  検証順序は 署名 → `typ`（`dpop+jwt`）→ `htm` → `htu` → `iat` 窓 → `jti` 重複 → `ath` 一致 に固定し、Agent OP 側で順序を組み替えない。
- `htm` は `POST` 固定。
  `htu` は `${ISSUER}/xaa/token` ではなく、実際に到達した URI（`X-Forwarded-Proto` と `Host` とパスから組み立てた値）を使う。
  direct プロファイルでは Agent OP が issuer と別ホストになるため、issuer から組み立てると必ず不一致になる（DEC-ID-04）。
- `/xaa/token` と `/xaa/subject-token` は Access Token を伴わないため `ath` は要求しない。
  Proof に `ath` が含まれていた場合は無視せず `invalid_dpop_proof` を返す。
- `iat` 許容窓は前後 60 秒に固定する。
  `jti` ストアの TTL は同じ 120 秒とする。
- 検証成功後に `c.set('dpopJkt', jkt)` を置く。
  `jkt` は Proof ヘッダの `jwk` の RFC 7638 thumbprint とする。
- 失敗時の HTTP は 400、ボディは `{"error":"invalid_dpop_proof"}` に固定する。
  `WWW-Authenticate` ヘッダを返さない。

**完了条件**
- [ ] `apps/agent-op/test/dpop-middleware.spec.ts` の `rejects request without DPoP header` が緑になる。
- [ ] 同ファイルの `rejects htu mismatch` が緑になる。
- [ ] 同ファイルの `rejects replayed jti` が緑になる。
- [ ] 同ファイルの `rejects proof carrying ath on /xaa/token` が緑になる。
- [ ] 同ファイルの `sets dpopJkt equal to RFC 7638 thumbprint of the proof jwk` が緑になる。

---

### T-OP-11 DPoP 関連3違反の Protocol Validation を実装する

**概要**
`invalid_dpop_proof`、`replayed_dpop_proof`、`dpop_key_binding_mismatch` の3つを Protocol Validation の違反コードとして発行する（REQ-09-026）。
判定そのものは同期処理として Agent OP に置き、Security Detection 側で再判定しない（DEC-SEC-02）。
特に、形式は正しいが別鍵で作った Proof が `dpop_key_binding_mismatch` になることを固定する。

**対象要件** REQ-09-026
**前提タスク** T-OP-10, T-SEC-11
**成果物**
- `apps/agent-op/src/validation/dpop-violations.ts`
- `apps/agent-op/test/dpop-violations.spec.ts`
- `e2e/test/agent-op/dpop-validation.spec.ts`

**実装方針**
- 3コードを `packages/xaa-contracts` の違反コード定数表から import する。
  Agent OP 側に文字列リテラルで書かない。
- 対応関係を固定する。
  署名不正と `htm` 不一致と `htu` 不一致と `iat` 範囲外は `invalid_dpop_proof`。
  `jti` 重複は `replayed_dpop_proof`。
  提示された Token の `cnf.jkt` と Proof の JWK thumbprint の不一致は `dpop_key_binding_mismatch`。
- 3つとも HTTP 400 と `{"error":"invalid_dpop_proof"}` を返す。
  違反コードは応答本文に載せず、構造化ログと Protocol Validation イベントにだけ載せる。
  クライアントへ失敗理由を区別させない。
- イベントは `emitProtocolValidation({ violation_code, agent_id, endpoint, jti })` で発行する。
  Rule / Correlation / Scoring のモジュールを import しない（T-OP-03 の ESLint 規則が効く）。
- `dpop_key_binding_mismatch` の判定対象は `/xaa/subject-token` で提示された ID-JAG ではなく、Resource 経路で使われる Access Token である。
  Agent OP 側では `cnf` を持つトークンを受け取る経路が subject-token 再取得のみであるため、そこで判定する。

**完了条件**
- [ ] `e2e/test/agent-op/dpop-validation.spec.ts` の `emits invalid_dpop_proof once for htu mismatch` が緑になる。
- [ ] 同ファイルの `emits replayed_dpop_proof once for duplicated jti` が緑になる。
- [ ] 同ファイルの `emits dpop_key_binding_mismatch for a well-formed proof made with another key` が緑になる。
- [ ] 3ケースすべてで応答本文が `{"error":"invalid_dpop_proof"}` の1種類のみであることを assert するテストが緑になる。

---

### T-OP-12 /xaa/token をステップ関数の固定順で組み立てる

**概要**
`/xaa/token` を `processIdJagIssuanceRequest` の一括関数ではなく、experimental の export 済みステップ関数を DEC-ID-06 の順で並べたルートとして実装する。
委譲照合と期限判定と resource 照合と cnf 付与を、subject と actor が揃った位置へ差し込むためである（DEV-08、REQ-08-020）。
生成物は `generated-baseline/agent-op-reference/` に参照用として置き、デプロイ経路には載せない。

**対象要件** REQ-08-020
**前提タスク** T-OP-07, T-OP-09, T-OP-10
**成果物**
- `apps/agent-op/src/routes/xaa-token.ts`
- `apps/agent-op/src/idjag/pipeline.ts`
- `generated-baseline/agent-op-reference/`（`maronn-oidc generate hono --enable id-jag` の無改変出力）
- `apps/agent-op/test/step-order.spec.ts`
- `packages/xaa-contracts/test/library-contract.spec.ts`

**実装方針**
- `pipeline.ts` に `runIdJagIssuance(input): Promise<IdJagIssuanceResponse>` を置き、次の13ステップをこの順で呼ぶ。
  1 `authorizeIdJagIssuanceClient`、2 `parseIdJagIssuanceParams`、3 `resolveIdJagSubject`、4 `resolveIdJagActorToken`、5 委譲照合（T-OP-17）、6 status と expires_at 判定（T-OP-19）、7 `validateIdJagAudience`、8 `validateIdJagScope`、9 resource 照合（T-OP-20）、10 `buildIdJagClaims`、11 cnf 付与と exp cap（T-OP-22、T-OP-23）、12 `signIdJag`（T-OP-07）、13 `buildIdJagIssuanceResponse`。
- 各ステップの前後で `recordStep(name, outcome)` を呼び、T-OP-30 のログがステップ境界で値を収集できるようにする。
- `processIdJagIssuanceRequest` と `createIdJagJwt` を import しない。
  import されていないことを `apps/agent-op/test/step-order.spec.ts` で grep 検査する。
- `packages/xaa-contracts/test/library-contract.spec.ts` に、使用する12個の export（`authorizeIdJagIssuanceClient`、`parseIdJagIssuanceParams`、`resolveIdJagSubject`、`resolveIdJagActorToken`、`validateIdJagAudience`、`validateIdJagScope`、`buildIdJagClaims`、`buildIdJagIssuanceResponse`、`IdJagError`、`TOKEN_EXCHANGE_GRANT_TYPE`、`ID_JAG_TOKEN_TYPE`、`TOKEN_TYPE_JWT`）が存在し、引数形状が期待どおりであることを検査する契約テストを書く。
  ライブラリのバージョンは exact 指定でピン留めする（DEC-ID-02）。
- `IdJagError` はルートの1か所で捕捉し、HTTP 400 と `{ error, error_description }` へ写像する。
  ステップ関数の中で HTTP レスポンスを組み立てない。
- ライブラリへ fork もパッチも当てない。

**完了条件**
- [ ] `apps/agent-op/test/step-order.spec.ts` の `calls the 13 steps in the fixed order` が緑になる（各ステップを spy で包み呼び出し順の配列を比較する）。
- [ ] 同ファイルの `imports neither processIdJagIssuanceRequest nor createIdJagJwt` が緑になる。
- [ ] `packages/xaa-contracts/test/library-contract.spec.ts` が緑になる。
- [ ] `generated-baseline/agent-op-reference/` が存在し、CI ジョブ `generate:baseline` が固定バージョンの CLI で再生成して差分0であることを確認する。

---

### T-OP-13 actor_token プロファイルと refresh_token subject の拒否を実装する

**概要**
`actor_token` を必須にし、`actor_token_type` を `urn:ietf:params:oauth:token-type:jwt` の1値へ固定する（REQ-05-067、DEC-ID-10）。
同時に `allowRefreshTokenSubjects` を false に固定し、`refreshTokenResolver` を注入しないことで、ドラフト §4.3 の MAY を採らないことを実装で表す（REQ-05-052、DEC-ID-19）。
これは本システム独自プロファイルであり、SAML 系や access_token 系の actor との相互運用を期待しない（DEV-03）。

**対象要件** REQ-05-067, REQ-05-052
**前提タスク** T-OP-12
**成果物**
- `apps/agent-op/src/idjag/config.ts`
- `packages/xaa-contracts/src/actor-token.ts`
- `apps/agent-op/test/actor-token-profile.spec.ts`

**実装方針**
- `parseIdJagIssuanceParams(params, { allowRefreshTokenSubjects: false, allowActorTokens: true })` を固定値で呼ぶ。
  `allowRefreshTokenSubjects` を環境変数や設定ファイルから読める形にしない。
- parse の直後に、`parsed.actorToken` が `undefined` なら `invalid_request` を返すガードを置く。
  ライブラリは actor_token を任意扱いにするため、必須化は Agent OP 側の責務になる。
- `parsed.actorTokenType` が `TOKEN_TYPE_JWT` 以外なら `invalid_request` を返す。
  `ACTOR_TOKEN_TYPES_SUPPORTED` をそのまま受理しない。
- `subject_token_type` が `urn:ietf:params:oauth:token-type:refresh_token` の要求は、`parseIdJagIssuanceParams` が `invalid_request` を投げる。
  Agent OP 側でこれを `invalid_grant` へ写像しない。
  refresh_token を subject にする経路が存在しないことを応答から読み取れてよい。
- `packages/xaa-contracts/src/actor-token.ts` に `ACTOR_TOKEN_TYP = 'agent-assertion+jwt'` と `AGENT_URN_PREFIX = 'urn:xaa:agent:'` と `toActorSub(agentId: string): string` を置く。
  同じ文字列を Agent OP と Agent Runtime に二重定義しない。
- `idjag/config.ts` は `IdJagIssuanceContext` 相当の値をリクエストごとに Agent Registration と XAA Static Configuration から組み立てる。
  プロセス起動時に固定した `allowedAudiences` を全 Agent で共有しない。

**完了条件**
- [ ] `apps/agent-op/test/actor-token-profile.spec.ts` の `rejects request without actor_token with invalid_request` が緑になる。
- [ ] 同ファイルの `rejects actor_token_type access_token with invalid_request` が緑になる。
- [ ] 同ファイルの `rejects subject_token_type refresh_token with invalid_request` が緑になる。
- [ ] `grep -rn "allowRefreshTokenSubjects" apps/agent-op/src` の出力が1件で、値が `false` のリテラルであることを検査するテストが緑になる。
- [ ] `grep -rn "refreshTokenResolver" apps/agent-op/src` が0件になる。

---

### T-OP-14 subject_token の検証とエラー写像を実装する

**概要**
`resolveIdJagSubject` を `clientId='agent-platform'` で呼び、subject_token の署名と `iss` と `exp` と `aud` を検証する（REQ-05-068）。
ライブラリは失敗時に `invalid_request` を投げるが、docs は `invalid_grant` を求めるため、ルートで写像する。
失敗理由を応答から区別できない固定文言を保つ。

**対象要件** REQ-05-068
**前提タスク** T-OP-13, T-OP-04
**成果物**
- `apps/agent-op/src/idjag/resolve-subject.ts`
- `apps/agent-op/test/subject-token.spec.ts`

**実装方針**
- `resolveIdJagSubject({ subjectToken, issuer: ISSUER, clientId: 'agent-platform', jwks: await subjectTokenJwks() })` を呼ぶ。
  JWKS は T-OP-04 の `idp-` 限定版を渡す（DEC-ID-20）。
  全鍵を含む JWKS を渡すと、Agent OP 自身の鍵で署名した JWT を subject_token として受理し得るため許さない。
- `IdJagError` を捕捉し、`code === 'invalid_request'` かつ `errorDescription === SUBJECT_TOKEN_INVALID_DESCRIPTION` の場合にのみ `invalid_grant` へ写像する。
  他の `invalid_request`（パラメータ欠落など）は写像しない。
- 写像後の `error_description` は `The provided subject_token is not valid` を維持する。
  署名不正と `iss` 不一致と `aud` 不一致と期限切れを区別する文言を作らない。
- 検証済みの `sub` を `c.set('subjectSub', subject.sub)` に置き、後段の委譲照合とログが参照する。
- `auth_time` と `acr` と `amr` は `IdJagSubject` に載ったものだけを引き継ぐ。
  Agent OP 側で補完しない。

**完了条件**
- [ ] `apps/agent-op/test/subject-token.spec.ts` の `maps subject token failure to invalid_grant` が緑になる。
- [ ] 同ファイルの `rejects ID Token with aud=automation-app` が緑になり `invalid_grant` が返る。
- [ ] 同ファイルの `error_description does not vary across signature / iss / aud / exp failures` が緑になる。
- [ ] 同ファイルの `rejects a JWT signed with the agent-op signing key as subject_token` が緑になる。

---

### T-OP-15 actorTokenResolver を実装する

**概要**
`resolveIdJagActorToken` へ渡す resolver を実装し、actor_token の署名を Agent Registration の `client_auth` の鍵で検証する（REQ-05-069）。
併せて、client_assertion で認証された agent_id と actor_token の `sub` が一致しない要求を拒否し、他 Agent の actor_token を作れないことを保証する（REQ-05-044）。
外部鍵取得ヘッダを持つ actor_token は署名検証へ進まず拒否する。

**対象要件** REQ-05-069, REQ-05-044
**前提タスク** T-OP-14
**成果物**
- `apps/agent-op/src/idjag/actor-token-resolver.ts`
- `apps/agent-op/test/actor-token.spec.ts`

**実装方針**
- resolver の先頭に型ガードを置き、`input.actorTokenType !== TOKEN_TYPE_JWT` なら `null` を返す（DEC-ID-10）。
  T-OP-13 で既に弾いているが、resolver 単体でも fail-closed にする。
- JOSE ヘッダの `typ` が `agent-assertion+jwt` でなければ `null` を返す。
  ヘッダに `jku` / `jwk` / `x5u` / `x5c` のいずれかがあれば署名検証へ進まず `null` を返す。
  `alg` が `ES256` 以外なら `null` を返す。
- ペイロードの `iss` と `sub` が同一で `agent-` 接頭辞を持つことを確認し、その値を `agent_id` とする。
  `c.get('authenticatedAgentId')` と一致しなければ `IdJagError('invalid_grant', ...)` を投げる。
  resolver から `null` を返すと `invalid_request` になるため、この分岐だけは例外を投げて `invalid_grant` にする。
- 署名検証は当該 Registration の `client_auth.public_jwk` で行う。
  共有 JWKS を actor_token の検証に使わない。
- 戻り値は `{ sub: toActorSub(agentId) }` とする。
  `act.sub` を `urn:xaa:agent:<agent_id>` へ正規化し、生の `agent_id` を `act.sub` に置かない。
- `input.jwks` と `input.issuer` を使わない。
  使わない理由をコメントで残す（actor_token は自 OP 発行の ID Token ではなく Agent 個体の assertion であるため）。

**完了条件**
- [ ] `apps/agent-op/test/actor-token.spec.ts` の `rejects actor_token signed with another agent key` が緑になり `invalid_grant` が返る。
- [ ] 同ファイルの `rejects actor_token with jwk header before signature check` が緑になる。
- [ ] 同ファイルの `rejects non-jwt actor_token_type` が緑になる。
- [ ] 同ファイルの `rejects cross-substituted client_assertion (agent-001 key, actor sub agent-002)` が緑になる。
- [ ] 同ファイルの `normalizes act.sub to urn:xaa:agent:<agent_id>` が緑になる。

---

### T-OP-16 actor_token の exp と jti 再利用を検証する

**概要**
actor_token の `exp` が現在時刻より後であること、`jti` が未使用であることを検証する（REQ-05-070）。
actor_token は Agent 個体が要求ごとに新規発行する短命 assertion であるため、再利用は盗用の兆候として扱う。
client_assertion の `jti` ストアとは別のストアで管理する。

**対象要件** REQ-05-070
**前提タスク** T-OP-15
**成果物**
- `apps/agent-op/src/idjag/actor-token-replay.ts`
- `apps/agent-op/test/actor-token-replay.spec.ts`

**実装方針**
- `exp` の比較は leeway 60 秒とする。
  `exp` が無い actor_token は `invalid_grant` にする。
- `exp - iat` が 300 秒（`ACTOR_TOKEN_MAX_AGE_SECONDS`）を超える actor_token は `invalid_grant` にする。
- `jti` ストアの TTL は 360 秒（最大寿命 300 秒に leeway 60 秒を足した値）とする。
  キーは `actor:${agent_id}:${jti}` とし、client_assertion の `assert:${agent_id}:${jti}` と衝突させない。
- ストアは同一 Cloud Run インスタンス内のインメモリ Map で実装し、TTL 経過後にエントリを削除する掃除処理を 60 秒間隔で回す。
  Firestore へは書かない。
  複数インスタンス間で共有されないことを既知の限界としてコメントとテスト名に残す。
- 失敗は `invalid_grant` に統一し、`error_description` は `The provided actor_token is not valid` に固定する。

**完了条件**
- [ ] `apps/agent-op/test/actor-token-replay.spec.ts` の `rejects the same actor_token on second use` が緑になる。
- [ ] 同ファイルの `rejects expired actor_token` が緑になる。
- [ ] 同ファイルの `rejects actor_token whose lifetime exceeds 300 seconds` が緑になる。
- [ ] 同ファイルの `evicts jti entries after 360 seconds` が緑になる。
- [ ] 同ファイルの `known limitation: jti store is per-instance` というテスト名で、限界が明示されていることを確認する。

---

### T-OP-17 委譲関係の照合ステップを実装する

**概要**
actor_token の `sub` で引いた Agent Registration の `human_subject` が subject_token の `sub` と一致しない場合に `invalid_grant` を返す（REQ-05-071）。
これは本プロファイルの要であり、ドラフト §9.7 が名指しで警告している攻撃への対策である。
`IdJagActorTokenResolverInput` は subject を受け取らないため、resolver 内ではなく DEC-ID-06 のステップ5の位置に置く（DEC-ID-07）。
同時に `delegation_mismatch` の Protocol Validation イベントを発行する（REQ-09-021）。

**対象要件** REQ-05-071, REQ-09-021
**前提タスク** T-OP-15, T-OP-16, T-SEC-11
**成果物**
- `apps/agent-op/src/idjag/verify-delegation.ts`
- `apps/agent-op/test/delegation.spec.ts`
- `e2e/test/agent-op/delegation-mismatch.spec.ts`

**実装方針**
- `verifyDelegation({ subjectSub, actorSub, registration }): void` を実装する。
  `actorSub` は `urn:xaa:agent:` 前置の正規化済み値であるため、`agent_id` を取り出してから Registration を照合する。
  照合対象は client_assertion で取得済みの Registration とし、Firestore を再度読まない。
- `registration.human_subject !== subjectSub` なら `IdJagError('invalid_grant', 'The delegation relationship could not be verified')` を投げる。
- 例外を投げる直前に `emitProtocolValidation({ violation_code: 'delegation_mismatch', agent_id, subject_sub: subjectSub, actor_sub: actorSub })` を呼ぶ。
  イベント発行はここ1か所のみとし、ルート側で重複発行しない。
- 判定結果（true / false）を `recordStep('delegation_check', outcome)` へ渡し、T-OP-30 のログ項目に載せる。
  一致した場合も `true` を記録する。
- 照合を迂回する設定フラグと環境変数を作らない。
- テスト名にドラフト §9.7 への参照を含める。

**完了条件**
- [ ] `apps/agent-op/test/delegation.spec.ts` の `draft 9.7: rejects subject_token(user-A) with actor of agent whose human_subject is user-B` が緑になる。
- [ ] `e2e/test/agent-op/delegation-mismatch.spec.ts` で HTTP 400 と `{"error":"invalid_grant"}` が返ることが緑になる。
- [ ] 同 e2e で `delegation_mismatch` イベントがちょうど1件記録されることが緑になる。
- [ ] `apps/agent-op/test/delegation.spec.ts` の `records delegation_check=true on match` が緑になる。

---

### T-OP-18 Agent Identity と Human Identity の名前空間分離を強制する

**概要**
`agent_id` を `agent-` 接頭辞の独立した名前空間とし、Human IdP の `sub` と同一値を取らせない（REQ-01-004）。
ID-JAG 発行時に `act.sub` が `sub` と同一値であれば `invalid_request` を返す。
Agent Registration の作成時にも同じ検証を行い、不正な Registration が保存されないようにする。

**対象要件** REQ-01-004
**前提タスク** T-OP-17
**成果物**
- `packages/xaa-contracts/src/agent-namespace.ts`
- `apps/agent-op/src/idjag/verify-namespace.ts`
- `apps/agent-op/test/namespace.spec.ts`

**実装方針**
- `packages/xaa-contracts/src/agent-namespace.ts` に `isAgentId(value: string): boolean`（`/^agent-[0-9a-z-]{1,60}$/` に一致するか）と `assertDistinctIdentities(humanSub: string, actorSub: string): void` を置く。
  Provisioner と Agent OP が同じ関数を使う。
- `assertDistinctIdentities` は、`actorSub` から `urn:xaa:agent:` を剥がした値が `humanSub` と等しい場合、または `humanSub` が `agent-` で始まる場合に例外を投げる。
- Agent OP では T-OP-17 の委譲照合の直前でこの検証を呼び、失敗時は `invalid_request` を返す。
  `invalid_grant` にしない。
  委譲関係の不一致（`invalid_grant`）と名前空間の侵犯（`invalid_request`）を別コードで区別する。
- Provisioner 側の Registration 作成でも同じ関数を呼ぶ。
  Agent OP 側だけの検証にしない。
- `human_subject` と `agent_id` の突き合わせを正規表現の部分一致で行わない。
  完全一致のみで判定する。

**完了条件**
- [ ] `apps/agent-op/test/namespace.spec.ts` の `rejects act.sub equal to sub with invalid_request` が緑になり HTTP 400 が返る。
- [ ] 同ファイルの `rejects human_subject starting with agent-` が緑になる。
- [ ] `packages/xaa-contracts/test/agent-namespace.spec.ts` の `isAgentId rejects agent_001 and user-123` が緑になる。
- [ ] Provisioner の Registration 作成テストで、`human_subject == agent_id` の入力が拒否されることが緑になる。

---

### T-OP-19 Agent の status と expires_at を要求ごとに判定する

**概要**
Token Exchange と subject_token 再取得のたびに Agent Registration の `expires_at` と `status` を確認する（REQ-05-072、REQ-07-016）。
`QUARANTINED` になった Agent へは ID-JAG も subject_token も出さない（REQ-09-048）。
判定は Firestore の値を都度読み、キャッシュ TTL は 10 秒を超えない。

**対象要件** REQ-05-072, REQ-07-016, REQ-09-048
**前提タスク** T-OP-18
**成果物**
- `apps/agent-op/src/idjag/verify-agent-state.ts`
- `apps/agent-op/src/store/registration-cache.ts`
- `apps/agent-op/test/expiry.spec.ts`
- `e2e/test/security/quarantine.spec.ts`

**実装方針**
- `verifyAgentState(registration, now): void` を実装する。
  `registration.expires_at <= now` なら `invalid_grant`。
  `registration.status` が `ACTIVE` と `EXPIRING` のどちらでもなければ `invalid_grant`。
  `REVOKED`、`EXPIRED`、`QUARANTINED` はすべて `invalid_grant` へ落とす。
- 時刻比較は Agent OP のサーバ時刻で行い、leeway を設けない。
  `Date.now()` を直接呼ばず、注入された `now: Date` を使う。
- `registration-cache.ts` の TTL は 10 秒に固定する。
  TTL を環境変数で伸ばせる形にしない。
  キャッシュキーは `agent_id` とする。
- 判定位置は DEC-ID-06 のステップ6、委譲照合の直後とする。
  `resolveIdJagSubject` より前に置かない。
  subject_token の有効性判定より先に Agent の状態を漏らさないためである。
- 既に払い出し済みのトークンをここで失効させない。
  失効は Lifecycle Cleanup の責務である。
- `/xaa/subject-token` でも同じ関数を呼ぶ。
  2経路で判定条件を分岐させない。

**完了条件**
- [ ] `apps/agent-op/test/expiry.spec.ts` の `rejects token exchange 10 seconds after expires_at is moved to the past` が緑になる。
- [ ] 同ファイルの `rejects subject-token reissue for the same agent` が緑になる。
- [ ] 同ファイルの `rejects status REVOKED and QUARANTINED with invalid_grant` が緑になる。
- [ ] `e2e/test/security/quarantine.spec.ts` の `no ID-JAG is issued 10 seconds after quarantine` が緑になる。
- [ ] `grep -rn "REGISTRATION_CACHE_TTL" apps/agent-op/src` の出力が1件で、値が定数 `10` であることを検査するテストが緑になる。

---

### T-OP-20 静的 XAA 設定との照合を実装する

**概要**
要求の `audience` と `scope` と `resource` を Agent の静的 XAA 設定と照合する（REQ-05-073）。
`audience` は `validateIdJagAudience`、`scope` は `validateIdJagScope` を使い、`resource` はライブラリに該当関数が無いため自前で照合する。
範囲外は `invalid_scope` を返し、`xaa_config_out_of_range` の Protocol Validation イベントを発行する（REQ-09-024）。

**対象要件** REQ-05-073, REQ-09-024
**前提タスク** T-OP-19, T-SEC-11
**成果物**
- `apps/agent-op/src/idjag/verify-xaa-config.ts`
- `apps/agent-op/test/xaa-config.spec.ts`
- `e2e/test/agent-op/xaa-out-of-range.spec.ts`

**実装方針**
- `audience` は Resource AS の issuer（https URL）と比較する（DEC-ID-05）。
  URN と比較しない。
  `validateIdJagAudience({ audience, issuer: ISSUER, allowedAudiences: config.allowed_audiences })` を呼ぶ。
  同関数は `invalid_target` を投げるため、ルートで `invalid_scope` へ写像する。
- `scope` は `validateIdJagScope(parsed.scope, config.scopes)` を呼ぶ。
  `config.scopes` を `undefined` にできる分岐を作らない。
  `undefined` を渡すとライブラリが素通しするため、空配列で初期化した値を必ず渡す。
- `resource` は `config.resources.includes(parsed.resource)` で完全一致照合する。
  接頭辞一致と部分一致を使わない。
  `resource` が省略された要求は `invalid_scope` にする（本システムでは RFC 8707 の絶対 URI を必須にする）。
- 照合順序を audience → scope → resource に固定する。
  最初に失敗した1件だけをイベントに載せ、後続の照合を行わない。
- 3ケースとも HTTP 400 と `{"error":"invalid_scope"}` を返す。
  `error_description` は許可リストの内容を露出しない固定文言 `The request is outside the static XAA configuration for this agent` とする。
- `emitProtocolValidation({ violation_code: 'xaa_config_out_of_range', field: 'audience' | 'scope' | 'resource', agent_id })` を発行する。

**完了条件**
- [ ] `e2e/test/agent-op/xaa-out-of-range.spec.ts` の `unregistered audience returns invalid_scope` が緑になる。
- [ ] 同ファイルの `unregistered resource returns invalid_scope` が緑になる。
- [ ] 同ファイルの `scope outside config returns invalid_scope` が緑になる。
- [ ] 同 e2e で `xaa_config_out_of_range` イベントが3ケースそれぞれ1件ずつ記録されることが緑になる。
- [ ] `apps/agent-op/test/xaa-config.spec.ts` の `resource matching rejects prefix and substring matches` が緑になる。

---

### T-OP-21 ID-JAG クレームを構築する

**概要**
`buildIdJagClaims` を呼び、docs 05 §6.4 のクレーム表どおりの ID-JAG を組み立てる（REQ-05-076）。
`sub` は委譲元の人間、`act.sub` は Agent、`client_id` は `agent-platform` 固定とする。
`sub` に Agent を置かず、`client_id` で Agent 個体を表さない（RULE-46、DEC-ID-22）。

**対象要件** REQ-05-076
**前提タスク** T-OP-20
**成果物**
- `apps/agent-op/src/idjag/build-claims.ts`
- `apps/agent-op/test/id-jag-claims.spec.ts`

**実装方針**
- `buildIdJagClaims({ issuer: ISSUER, subject, audience, clientId: 'agent-platform', scope, resource, actor, lifetimeSeconds, now })` を呼ぶ。
  `clientId` に `agent_id` を渡さない。
- `issuer` は Human IdP と同一の文字列を渡す（DEC-ID-03、DEV-15）。
  Agent OP のホスト名から組み立てない。
- 戻り値へ Agent OP 側で `isolation_level` を追加する。
  値は Agent Registration の `isolation_level`（`standard` または `full_isolation`）をそのまま入れる。
  Finance Resource AS がこのクレームで `insufficient_isolation` を判定するため、省略できる分岐を作らない。
- `jti` はライブラリが生成する 256bit のランダム値をそのまま使う。
  Agent OP 側で再生成しない。
- クレーム集合を `{ iss, sub, aud, client_id, jti, exp, iat, scope, resource, act, isolation_level }` の11個に固定する。
  `auth_time` と `acr` と `amr` は subject_token に存在した場合のみ加わる。
  それ以外のクレームを足さない。

**完了条件**
- [ ] `apps/agent-op/test/id-jag-claims.spec.ts` の `sub is the human subject and act.sub is the agent urn` が緑になる。
- [ ] 同ファイルの `client_id is always agent-platform` が緑になる。
- [ ] 同ファイルの `iss equals the human-idp issuer byte-exact` が緑になる。
- [ ] 同ファイルの `isolation_level is copied from the registration` が緑になる。
- [ ] 同ファイルの `claim set contains no keys outside the fixed list` が緑になる。

---

### T-OP-22 cnf.jkt を付与し cnf 無しの発行経路を持たせない

**概要**
ID-JAG に `cnf.jkt` を付与する（REQ-05-077）。
`IdJagClaims` 型に `cnf` は無いが、`buildIdJagClaims` の戻り値をスプレッドして `{...claims, cnf: { jkt }}` を作り、`Record<string, unknown>` を受ける `signIdJag` へ渡す（DEC-ID-08）。
cnf を欠いた ID-JAG を発行する分岐を実装しない（REQ-05-079）。

**対象要件** REQ-05-077, REQ-05-079
**前提タスク** T-OP-21, T-OP-10
**成果物**
- `apps/agent-op/src/idjag/attach-cnf.ts`
- `apps/agent-op/test/id-jag-cnf.spec.ts`

**実装方針**
- `attachCnf(claims: IdJagClaims, jkt: string): Record<string, unknown>` を実装する。
  `jkt` は T-OP-10 が `c.set('dpopJkt', ...)` に置いた値をそのまま使う。
  ここで thumbprint を再計算しない。
- `signIdJag` の引数型は `Record<string, unknown>` であるため、`as` による cast を書かない。
  cast を書かずに済むことが DEC-ID-08 の狙いである旨をコメントに残す。
- `jkt` が空文字列または `undefined` の場合は `attachCnf` が例外を投げる。
  cnf 省略のフォールバックと設定フラグを作らない。
- T-OP-10 の DPoP ミドルウェアが `/xaa/token` で必須であるため、Proof 無しの要求は `signIdJag` に到達しない。
  `attachCnf` の例外は多重防御であり、通常経路では発火しない旨をコメントに書く。
- `apps/agent-op/src` に `cnf` を条件付きで付ける `if` を置かない。
  静的検査で `cnf` の代入箇所が `attach-cnf.ts` の1件のみであることを確認する。

**完了条件**
- [ ] `apps/agent-op/test/id-jag-cnf.spec.ts` の `always includes cnf.jkt` が緑になる。
- [ ] 同ファイルの `cnf.jkt equals the RFC 7638 thumbprint of the proof jwk` が緑になる。
- [ ] 同ファイルの `never signs without cnf` が緑になり、`attachCnf('')` が例外を投げる。
- [ ] `grep -rn "cnf" apps/agent-op/src --include=*.ts` の代入箇所が `attach-cnf.ts` の1件のみであることを検査するテストが緑になる。
- [ ] `grep -rn " as unknown as\| as IdJagClaims" apps/agent-op/src/idjag` が0件になる。

---

### T-OP-23 ID-JAG の exp を Agent の expires_at で打ち切る

**概要**
ID-JAG の `exp` を `min(iat + idJagLifetimeSeconds, Agent Registration の expires_at)` とする（REQ-05-078、REQ-07-017）。
計算結果が現在時刻以下になる場合は発行せず `invalid_grant` を返す（DEC-ID-09）。
これはデモ D-3 の Authorization 層の拒否に対応する。

**対象要件** REQ-05-078, REQ-07-017
**前提タスク** T-OP-22
**成果物**
- `apps/agent-op/src/idjag/cap-exp.ts`
- `apps/agent-op/test/idjag-exp.spec.ts`

**実装方針**
- `capExp(claims: Record<string, unknown>, expiresAt: Date, now: Date): Record<string, unknown>` を実装する。
  `iat` は `buildIdJagClaims` が入れた値をそのまま使い、再計算しない。
- `ID_JAG_LIFETIME_SECONDS` の既定は 300 とする。
  上限は `agent_max_lifetime_seconds`（DEC-IAC-16）から導出された Registration の `expires_at` である。
- `Math.min(iat + lifetime, floor(expiresAt / 1000))` を `exp` に上書きする。
  上書き後の `exp <= floor(now / 1000)` なら `IdJagError('invalid_grant', 'The agent lifetime does not allow issuing a grant')` を投げる。
- `expires_in` は `exp - iat` を使い、`buildIdJagIssuanceResponse` へ渡す。
  `lifetimeSeconds` をそのまま返さない。
- 打ち切りを無効化する設定フラグを作らない。
- `capExp` は `attachCnf` の後、`signIdJag` の前に呼ぶ。
  署名後に `exp` を書き換える経路を作らない。

**完了条件**
- [ ] `apps/agent-op/test/idjag-exp.spec.ts` の `exp - iat equals 60 when expires_at is 60 seconds away` が緑になる。
- [ ] 同ファイルの `exp - iat equals 300 when expires_at is 600 seconds away` が緑になる。
- [ ] 同ファイルの `returns invalid_grant when expires_at is in the past` が緑になる。
- [ ] 同ファイルの `expires_in in the response equals exp - iat` が緑になる。

---

### T-OP-24 Human IdP Connection レコードと封筒暗号を実装する

**概要**
Agent ごとの Human IdP Connection を Firestore `idp_connections` に実装する（REQ-05-045）。
Refresh Token は KMS の `idp-connection-encryption` 鍵で暗号化して保存し、平文を Firestore にもログにも置かない。
`expires_at` は Agent Registration の `expires_at` と同値にする（DEC-IAC-16）。

**対象要件** REQ-05-045
**前提タスク** T-OP-02, T-IAC-18
**成果物**
- `apps/agent-op/src/idp-connection/types.ts`
- `apps/agent-op/src/idp-connection/repository.ts`
- `apps/agent-op/src/idp-connection/crypto.ts`
- `apps/agent-op/test/idp-connection.spec.ts`

**実装方針**
- レコードのフィールドを `idp_connection_id`、`agent_id`、`human_subject`、`encrypted_refresh_token`、`granted_scopes: string[]`、`status: 'ACTIVE' | 'REVOKED'`、`created_at`、`expires_at` の8つに固定する。
  平文の `refresh_token` フィールドを型に持たせない。
- 暗号化は `packages/gcp` の KMS クライアントの `encrypt` を使い、`additionalAuthenticatedData` に `agent_id` を渡す。
  復号時に `agent_id` が一致しなければ KMS が失敗するため、他 Agent の暗号文を流用できない。
- FULL_ISOLATION のスロットでは `KMS_IDP_CONNECTION_KEY` がスロット専用鍵を指す（DEC-IAC-07）。
  鍵名の解決は T-OP-06 の `resolveSigningKeyName` と同じ規約で `idpconn-slot-<SLOT_INDEX>` とする。
- `expires_at` の書き込み値は Agent Registration から読んだ値をそのまま使う。
  Agent OP 側で足し算しない。
- `toJSON` と `toString` をオーバーライドし、`encrypted_refresh_token` を `[redacted]` に置き換える。
  ログ出力時の事故を型の側で塞ぐ。
- `granted_scopes` は `openid offline_access` の2値のみを想定する。
  Google の scope をここに保存しない（それは Bridge 側の Connector Connection の責務）。

**完了条件**
- [ ] `apps/agent-op/test/idp-connection.spec.ts` の `expires_at equals the registration expires_at` が緑になる。
- [ ] 同ファイルの `decrypt fails when agent_id AAD differs` が緑になる。
- [ ] 同ファイルの `JSON.stringify redacts encrypted_refresh_token` が緑になる。
- [ ] 同ファイルの `type has no plaintext refresh_token field` が `tsc --noEmit` の型テストで緑になる。
- [ ] Provisioning 完了時に Agent 1体につき `idp_connections` が1件だけ作られることを確認する統合テストが緑になる。

---

### T-OP-25 /xaa/callback と offline_access 認可の中断再開を実装する

**概要**
Provisioning の途中でユーザーを Human IdP の `/authorize` へ送り、戻ってきた code を `/xaa/callback` で token 交換して Refresh Token を保存する（REQ-05-047）。
Provisioning Transaction を再開させ、Agent の起動へ進ませる。
このサービスは `MODE=callback` かつ ingress=ALL で公開する（DEC-IAC-14）。

**対象要件** REQ-05-047
**前提タスク** T-OP-24, T-OP-01, T-PROV-03, T-IDP-04
**成果物**
- `apps/agent-op/src/routes/xaa-callback.ts`
- `apps/agent-op/src/idp-connection/authorize-url.ts`
- `apps/agent-op/test/xaa-callback.spec.ts`
- `e2e/test/agent-op/offline-access.spec.ts`

**実装方針**
- `buildAuthorizeUrl({ transactionId, codeVerifier }): string` を実装し、`client_id=agent-platform`、`scope=openid offline_access`、`redirect_uri=${AGENT_OP_CALLBACK_URL}/xaa/callback`、`response_type=code`、`state=<transaction_id>`、`code_challenge_method=S256` を組み立てる。
  PKCE を省略できる分岐を作らない。
- `state` の値は Provisioning Transaction の ID そのものではなく、`transaction_id` を鍵にして Firestore に保存した 256bit のランダム値とする。
  `state` から Transaction を逆引きし、1回使ったら削除する。
- `/xaa/callback` は `code` と `state` を受け取り、`state` の存在と未使用を確認してから Human IdP の `/token` へ `grant_type=authorization_code` を送る。
  `code_verifier` は Transaction に保存したものを使う。
- 応答の `refresh_token` を T-OP-24 の `crypto.ts` で暗号化し、`idp_connections` へ `status=ACTIVE` で保存する。
  `access_token` と `id_token` は保存せず破棄する。
- 保存の成功後に Provisioning Transaction を `RESUMED` へ遷移させる。
  遷移は Firestore の `runTransaction` で行い、二重再開を防ぐ。
- `error` パラメータ付きで戻ってきた場合は Transaction を `FAILED` にし、ブラウザには失敗を示す HTML を返す。
  Human IdP の `error_description` をそのまま画面に出さない。
- `MODE=callback` のプロセスは ID-JAG 署名鍵の KMS 権限を必要としない経路のみを実装する。

**完了条件**
- [ ] `e2e/test/agent-op/offline-access.spec.ts` の `transaction becomes RESUMED and idp_connection becomes ACTIVE after consent` が緑になる。
- [ ] `apps/agent-op/test/xaa-callback.spec.ts` の `rejects reused state` が緑になる。
- [ ] 同ファイルの `rejects callback without PKCE code_verifier in the transaction` が緑になる。
- [ ] 同ファイルの `stores only the refresh token and discards access_token and id_token` が緑になる。
- [ ] 同ファイルの `sets transaction to FAILED on error parameter` が緑になる。

---

### T-OP-26 コールバックのリダイレクトでトークンを返さない

**概要**
`/xaa/callback` からブラウザへ返すのは `transaction_id` と one-time code だけとする（REQ-05-048、RULE-23）。
`access_token` と `refresh_token` と `id_token` を、クエリとフラグメントと Cookie のいずれでも返さない。
これは検査可能な形の negative test で固定する。

**対象要件** REQ-05-048
**前提タスク** T-OP-25
**成果物**
- `apps/agent-op/src/routes/xaa-callback.ts`（T-OP-25 に追記）
- `apps/agent-op/test/callback-no-token.spec.ts`

**実装方針**
- 成功時の応答は 302 とし、`Location` は `${AUTOMATION_APP_URL}/provisioning/resume?transaction_id=<id>&code=<one_time_code>` に固定する。
  `one_time_code` は 128bit のランダム値で、Firestore に TTL 300 秒で保存し、1回の引き換えで削除する。
- 応答に `Set-Cookie` を1つも付けない。
  セッションを Agent OP 側に持たない。
- 応答本文を空にする。
  デバッグ用に token を本文へ出す分岐を作らない。
- テストは `Location` ヘッダ全体と本文と全 `Set-Cookie` ヘッダを連結した文字列に対し、`access_token`、`refresh_token`、`id_token`、`token=` の4パターンが現れないことを検査する。
  正規表現は `/(access_token|refresh_token|id_token|[?&#]token=)/` に固定する。
- 検査対象に失敗時応答も含める。

**完了条件**
- [ ] `apps/agent-op/test/callback-no-token.spec.ts` の `success response carries no token-bearing parameter` が緑になる。
- [ ] 同ファイルの `error response carries no token-bearing parameter` が緑になる。
- [ ] 同ファイルの `sets no cookie` が緑になる。
- [ ] 同ファイルの `one_time_code is single use` が緑になり、2回目の引き換えが 400 になる。

---

### T-OP-27 /xaa/subject-token を実装する

**概要**
Agent Runtime が subject_token を失効させた際の再取得口として `POST /xaa/subject-token` を実装する（REQ-05-051）。
DEC-ID-19 のとおり ID Token を自前生成せず、保存済み Refresh Token で Human IdP の `/token` を叩き、応答の `id_token` だけを返す。
`access_token` と `refresh_token` はレスポンスに含めない。

**対象要件** REQ-05-051
**前提タスク** T-OP-24, T-OP-19, T-OP-09, T-OP-10
**成果物**
- `apps/agent-op/src/routes/xaa-subject-token.ts`
- `apps/agent-op/test/subject-token-endpoint.spec.ts`
- `e2e/test/agent-op/subject-token-reissue.spec.ts`

**実装方針**
- 認証は T-OP-09 の `client_assertion_jwt` と T-OP-10 の DPoP を両方必須にする。
  どちらか一方で通る分岐を作らない。
- T-OP-19 の `verifyAgentState` を呼び、`status` が `ACTIVE` か `EXPIRING` で `expires_at` 内であることを確認する。
  `QUARANTINED` は `invalid_grant` で拒否する。
- `idp_connections` から当該 Agent の1件を引き、`status === 'ACTIVE'` かつ `expires_at > now` を確認する。
  違反は `invalid_grant` にする。
- KMS で復号した Refresh Token で Human IdP の `${HUMAN_IDP_TOKEN_URL}` へ `grant_type=refresh_token&client_id=agent-platform&refresh_token=<rt>` を送る。
  `scope` を送らない。
- 応答 JSON から `id_token` だけを取り出し、`{ "subject_token": "<id_token>", "subject_token_type": "urn:ietf:params:oauth:token-type:id_token", "expires_in": <数値> }` を返す。
  `access_token` と `refresh_token` のキーを応答に置かない。
- Human IdP が返した新しい `refresh_token` は T-OP-28 の rotation 処理へ渡す。
  応答へは載せない。
- Human IdP が `invalid_grant` を返した場合は、そのまま `invalid_grant` を返し、T-OP-29 の再利用検知へ渡す。

**完了条件**
- [ ] `e2e/test/agent-op/subject-token-reissue.spec.ts` の `runtime obtains a fresh ID Token and completes ID-JAG issuance` が緑になる。
- [ ] `apps/agent-op/test/subject-token-endpoint.spec.ts` の `response JSON has no refresh_token key` が緑になる。
- [ ] 同ファイルの `response JSON has no access_token key` が緑になる。
- [ ] 同ファイルの `rejects request without DPoP` と `rejects request without client_assertion` が緑になる。
- [ ] 同ファイルの `rejects QUARANTINED agent with invalid_grant` が緑になる。

---

### T-OP-28 Refresh Token の rotation と Revoke 経路を実装する

**概要**
docs 01 §4 の `OP -->|subject_token / Revoke| HIDP` を実装する（REQ-01-028）。
Refresh Token Rotation に対応して新しい Refresh Token を保存し直し、Cleanup 時には同じ Refresh Token を Human IdP の `/revoke`（RFC 7009）へ送る。
Refresh Token を Agent OP のプロセス外へ出さない（RULE-22、RULE-51）。

**対象要件** REQ-01-028
**前提タスク** T-OP-27, T-IDP-05, T-LIFE-05
**成果物**
- `apps/agent-op/src/idp-connection/rotate.ts`
- `apps/agent-op/src/routes/internal-revoke-connection.ts`
- `apps/agent-op/test/rotation-revoke.spec.ts`
- `e2e/test/agent-op/revoke.spec.ts`

**実装方針**
- `rotateRefreshToken(connectionId, newRefreshToken)` は Firestore の `runTransaction` で `encrypted_refresh_token` を差し替える。
  古い暗号文を別フィールドへ残さない。
  再利用検知（T-OP-29）は古い平文のハッシュを別コレクションで管理する。
- Human IdP の応答に `refresh_token` が含まれない場合は rotation を行わず、既存の暗号文を保つ。
  無条件に上書きしない。
- `POST /internal/revoke-connection` を `MODE=token` に追加し、呼び出し元を `sa-lifecycle` の Google 発行 ID Token に限る（T-OP-08 の `verifyGoogleServiceIdentity` を使う）。
  ボディは `{ agent_id }` のみを受ける。
- 処理は 復号 → Human IdP の `${HUMAN_IDP_REVOKE_URL}` へ `token=<rt>&token_type_hint=refresh_token&client_id=agent-platform` を POST → `idp_connections` の `status` を `REVOKED` へ更新 の順とする。
  Human IdP が非 200 を返しても `status` は `REVOKED` にし、ログへ `revoke_result=failed` を残す。
  失効を諦めない。
- Refresh Token の平文が現れる変数のスコープを関数内に閉じ、戻り値と例外メッセージとログに載せない。
  `apps/agent-op/src` に Refresh Token を引数で受け取って外へ返す関数を作らない。

**完了条件**
- [ ] `e2e/test/agent-op/revoke.spec.ts` の `subject-token reissue after revoke returns invalid_grant` が緑になる。
- [ ] `apps/agent-op/test/rotation-revoke.spec.ts` の `keeps the existing ciphertext when the response has no refresh_token` が緑になる。
- [ ] 同ファイルの `marks connection REVOKED even when human-idp revoke fails` が緑になる。
- [ ] 同ファイルの `rejects /internal/revoke-connection from a non sa-lifecycle identity` が緑になる。
- [ ] ログ検査テスト `no log line contains the refresh token string` が緑になる。

---

### T-OP-29 Refresh Token の再利用を検知する

**概要**
rotate 済みの Refresh Token が再提示された場合を `refresh_token_reuse` として Protocol Validation で扱う（REQ-09-025）。
Refresh Token の保持者は Agent OP だけであるため、再利用は漏洩の証拠として扱う。
検知時は当該 `idp_connection_id` を即座に無効化し、Human IdP へ Revoke を送る。

**対象要件** REQ-09-025
**前提タスク** T-OP-28, T-SEC-11
**成果物**
- `apps/agent-op/src/idp-connection/reuse-detection.ts`
- `apps/agent-op/test/refresh-reuse.spec.ts`
- `e2e/test/agent-op/refresh-reuse.spec.ts`

**実装方針**
- rotation のたびに、置き換え前の Refresh Token の SHA-256 を `idp_connection_rotations/{connection_id}/used/{hash}` へ TTL 付きで記録する。
  平文と暗号文を記録しない。
- `/xaa/subject-token` で Human IdP が `invalid_grant` を返したとき、提示した Refresh Token のハッシュが `used` に存在すれば `refresh_token_reuse` と判定する。
  存在しなければ単なる失効として扱い、違反コードを出さない。
- 検知時の処理順を 違反イベント発行 → `idp_connections` の `status` を `REVOKED` へ更新 → Human IdP の `/revoke` を呼ぶ に固定する。
  イベント発行を最後に置かない。
- 応答は `invalid_grant` に統一する。
  再利用であることを応答から区別させない。
- 再利用検知を無効化する設定フラグを作らない。

**完了条件**
- [ ] `e2e/test/agent-op/refresh-reuse.spec.ts` の `second use of the same refresh token returns invalid_grant` が緑になる。
- [ ] 同 e2e で `refresh_token_reuse` イベントが1件記録されることが緑になる。
- [ ] 同 e2e で対象 `idp_connection` の `status` が `revoked` になることが緑になる。
- [ ] `apps/agent-op/test/refresh-reuse.spec.ts` の `does not emit reuse for a token that was never rotated` が緑になる。

---

### T-OP-30 Token Exchange のログ14項目を出力する

**概要**
Token Exchange 要求のたびに、docs 09 §2 が求める14項目を構造化ログへ出す（REQ-09-008）。
T-OP-12 の各ステップ境界で値を収集し、成功と失敗の両方で同じ形のレコードを出す。
Raw な JWT 文字列をログへ書かない。

**対象要件** REQ-09-008
**前提タスク** T-OP-12, T-OP-17, T-OP-23
**成果物**
- `apps/agent-op/src/log/token-exchange-log.ts`
- `apps/agent-op/test/token-exchange-log.spec.ts`
- `e2e/test/agent-op/token-exchange-log.spec.ts`

**実装方針**
- 出力する14項目を固定する。
  `op_runtime_id`（Cloud Run の revision 名）、`op_kind`（`shared` または `dedicated`）、`requested_audience`、`requested_resource`、`requested_scope`、`subject_token_iss`、`subject_token_aud`、`subject_token_sub`、`actor_token_sub`、`actor_token_jti`、`delegation_check`（true / false）、`dpop_result`（`ok` または違反コード）、`issued_id_jag`（`{ jti, kid, cnf_jkt }`）、`agent_expiry_check`（`ok` または `expired` または `not_active`）、`error_code`（成功時は `null`）。
- 出力先は Cloud Logging の構造化ログ（`console.log(JSON.stringify(...))`）とする。
  BigQuery へアプリから直接書かない（DEC-SEC-01）。
- ステップ境界の収集は `recordStep` が返す `TokenExchangeTrace` オブジェクトへ書き込み、ルートの `finally` で1件だけ出力する。
  ステップごとに1行ずつ出さない。
- Raw JWT を載せないことを型で担保する。
  `TokenExchangeTrace` の各フィールドを `string`（識別子）と `boolean` と `number` に限り、トークン文字列を受け取るフィールドを持たせない。
- ログ検査テストは、出力された JSON 文字列に `eyJ`（compact JWS の先頭）が現れないことを assert する。
- `phase` と `outcome` は Activity Event 側（T-OP-33）の責務とし、このログには含めない。

**完了条件**
- [ ] `e2e/test/agent-op/token-exchange-log.spec.ts` の `success emits all 14 fields` が緑になる。
- [ ] 同ファイルの `RULE-49 violation emits all 14 fields with delegation_check=false` が緑になる。
- [ ] 同ファイルの `no log line contains a compact JWS` が緑になる。
- [ ] `apps/agent-op/test/token-exchange-log.spec.ts` の `emits exactly one record per request` が緑になる。

---

### T-OP-31 Human IdP Connection のログ5項目を出力する

**概要**
Human IdP Connection の操作ごとに5項目を構造化ログへ出す（REQ-09-009）。
Refresh Token 本体と暗号文をログへ書かない。
rotation と再利用検知と Revoke の3経路がすべて同じ形のレコードを出す。

**対象要件** REQ-09-009
**前提タスク** T-OP-28, T-OP-29
**成果物**
- `apps/agent-op/src/log/idp-connection-log.ts`
- `apps/agent-op/test/idp-connection-log.spec.ts`
- `e2e/test/agent-op/idp-connection-log.spec.ts`

**実装方針**
- 出力する5項目を固定する。
  `idp_connection_id`、`rotation_result`（`rotated` または `failed` または `not_rotated`）、`reuse_detected`（true / false）、`subject_token_reissue`（`ok` または `failed` または `n/a`）、`revoke_result`（`ok` または `failed` または `n/a`）。
- `agent_id` と `human_subject` はこのレコードに含めない。
  相関は `idp_connection_id` で取る。
- Refresh Token の SHA-256 もログへ出さない。
  再利用検知の内部でのみ使う。
- 3経路（rotation、reuse、revoke）でそれぞれ1件ずつ出す。
  経路によって欠落する項目は `n/a` を明示的に入れ、キー自体を省かない。

**完了条件**
- [ ] `e2e/test/agent-op/idp-connection-log.spec.ts` の `rotation path emits all 5 fields` が緑になる。
- [ ] 同ファイルの `reuse path emits reuse_detected=true` が緑になる。
- [ ] 同ファイルの `revoke path emits revoke_result` が緑になる。
- [ ] 同ファイルの `no record contains the refresh token or its ciphertext or its hash` が緑になる。

---

### T-OP-32 ID-JAG 発行台帳を出力する

**概要**
ID-JAG 発行のたびに `idjag_issuance` レコードを構造化ログへ出す（REQ-09-022）。
これは Resource AS 側で受け取った JWT との突合に使い、Agent OP の kid で署名されているが発行記録に対応が無い ID-JAG を検出する材料になる（`signing_key_misuse`）。
Raw JWT を書かない。

**対象要件** REQ-09-022
**前提タスク** T-OP-30
**成果物**
- `apps/agent-op/src/log/issuance-ledger.ts`
- `apps/agent-op/test/issuance-ledger.spec.ts`
- `e2e/test/agent-op/issuance-ledger.spec.ts`

**実装方針**
- レコードのフィールドを13個に固定する。
  `jti`、`kid`、`typ`（常に `oauth-id-jag+jwt`）、`iss`、`sub`、`act_sub`、`aud`、`resource`、`scope`、`exp`、`iat`、`agent_id`、`slot_id`（`SLOT_INDEX < 0` のとき `null`）。
- `logName` は `idjag_issuance` に固定する。
  T-OP-30 の Token Exchange ログと同じレコードにまとめない。
  Security Detection の SQL が2つを別テーブルとして扱うためである。
- 出力は `signIdJag` の成功直後、`buildIdJagIssuanceResponse` の前とする。
  応答返却後の非同期出力にしない。
- 発行に至らなかった要求ではこのレコードを出さない。
  拒否は T-OP-30 のログにだけ現れる。
- `jti` は `buildIdJagClaims` が生成した値をそのまま使う。

**完了条件**
- [ ] `e2e/test/agent-op/issuance-ledger.spec.ts` の `three issuances produce three records with distinct jti` が緑になる。
- [ ] 同ファイルの `rejected request produces no idjag_issuance record` が緑になる。
- [ ] `apps/agent-op/test/issuance-ledger.spec.ts` の `record contains exactly the 13 fields` が緑になる。
- [ ] 同ファイルの `record contains no compact JWS` が緑になる。

---

### T-OP-33 PROTOCOL_VIOLATION の Activity Event を発行する

**概要**
Agent OP の `/xaa/token` で検知した違反を `PROTOCOL_VIOLATION`（`phase=security`、`outcome=blocked`）の Activity Event として発行する（REQ-11-018）。
発行元は Agent OP と Agent Runtime の Tool Executor と Native Resource AS の3箇所に限る。
Human IdP と Google Bridge は Security ログのみを出し、Activity Event を出さない。

**対象要件** REQ-11-018
**前提タスク** T-OP-11, T-OP-17, T-OP-20, T-OP-29
**成果物**
- `apps/agent-op/src/log/protocol-violation-event.ts`
- `apps/agent-op/test/protocol-violation-event.spec.ts`
- `e2e/test/activity/protocol-violation-event.spec.ts`

**実装方針**
- `emitProtocolViolationEvent({ violation_code, agent_id, human_subject, task_id })` を実装し、Pub/Sub トピック `agent-activity-stream` へ publish する。
  `PUBSUB_MODE=inproc` のときは同一プロセス内のディスパッチャへ渡す（DEC-APP-09）。
- イベントの `message` は違反コードに対応する日本語名にする。
  対応表は `packages/xaa-contracts` の1ファイルに置き、Agent OP 側に文字列を重複させない。
  Agent OP が出す違反コードは `delegation_mismatch`、`xaa_config_out_of_range`、`invalid_dpop_proof`、`replayed_dpop_proof`、`dpop_key_binding_mismatch`、`refresh_token_reuse` の6件とする。
- `detail.violation_code` に生の違反コードを入れる。
  `detail` に subject_token と actor_token の文字列を入れない。
- `phase` は `security`、`outcome` は `blocked` に固定する。
  引数で変えられるようにしない。
- T-OP-11 と T-OP-17 と T-OP-20 と T-OP-29 の各判定箇所からこの1関数だけを呼ぶ。
  publish を直接呼ぶ箇所を作らない。
- 台本デモ（`is_simulated=true`）はこの経路を通らない（DEC-DEMO-01）。
  `is_simulated` を引数に持たせない。

**完了条件**
- [ ] `e2e/test/activity/protocol-violation-event.spec.ts` の `agent-op emits one PROTOCOL_VIOLATION per violation` が緑になる。
- [ ] 同ファイルの `detail.violation_code is one of the enumerated codes` が緑になる。
- [ ] 同ファイルの `human-idp authentication failure emits no Activity Event` が緑になる。
- [ ] `apps/agent-op/test/protocol-violation-event.spec.ts` の `phase and outcome are not parameterizable` が `tsc --noEmit` の型テストで緑になる。
- [ ] `grep -rn "agent-activity-stream" apps/agent-op/src` の出力が `protocol-violation-event.ts` の1件のみになる。
