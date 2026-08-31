# 02. 共有パッケージとテスト基盤（T-PKG）

この領域は、すべてのアプリが共通して使う暗号処理と識別子の契約、そしてテストと CI の土台を作る。
具体的には DPoP（RFC 9449）の鍵生成と Proof 生成/検証、RFC 7638 の JWK Thumbprint、Cloud KMS の ES256 署名と DER から R||S への変換、base64url と SHA-256 を `packages/xaa-crypto` に置き、typ と grant_type と scope と Capability と Tool ID の定数表、JSON Schema と Ajv 検証、アプリ間 HTTP の入口となる httpClient ラッパを `packages/xaa-contracts` に置く。
あわせて、全アプリを同一プロセスの Hono として `app.fetch` で呼ぶ integration ハーネス、モード切替の環境変数、生成 OP のストアを支える Firestore バックエンド、単一 Dockerfile、Makefile、CI ジョブ一式を用意する。
maronn-openid-connect は DPoP と private_key_jwt に対応しないため、その穴を埋めるのがこの領域の主目的になる（DEC-ID-12、DEV-01）。
他の全領域がこの領域の成果物に依存するので、P0 の spike と並行して最初に着手する。

| 前提 | 内容 |
|---|---|
| 依存する領域 | なし。infra の spike（DEC-SCOPE-02）の完了を待たずに着手できる |
| このファイルのタスク数 | 30件 |
| 主に満たす設計ルール | RULE-06, RULE-44, RULE-48, RULE-38, RULE-45 |

---

### T-PKG-01 pnpm workspace とビルド規約を敷く

**概要**
リポジトリのルート構成、TypeScript の設定、テストランナーの設定を作る。
以降のすべてのタスクがこの設定の上に乗る。
DEC-APP-01 の単一リポジトリ構成と DEC-APP-02 の Node 22 + ESM + tsc ビルドに対応する。

**対象要件** なし（DEC-APP-01、DEC-APP-02 に基づく基盤タスク）
**前提タスク** なし
**成果物**
- `pnpm-workspace.yaml`
- `package.json`（ルート）
- `tsconfig.base.json`
- `vitest.workspace.ts`
- `eslint.config.js`
- `.node-version`
- `.npmrc`
- `packages/xaa-crypto/package.json`, `packages/xaa-crypto/tsconfig.json`
- `packages/xaa-contracts/package.json`, `packages/xaa-contracts/tsconfig.json`

**実装方針**
- `pnpm-workspace.yaml` の packages に `apps/*`、`packages/*`、`e2e` の3つだけを列挙する。
- パッケージ名は `@xaa/crypto`、`@xaa/contracts` とする。スコープ名を他の値にしない。
- `tsconfig.base.json` は `"module": "NodeNext"`、`"moduleResolution": "NodeNext"`、`"target": "ES2023"`、`"strict": true`、`"noUncheckedIndexedAccess": true`、`"verbatimModuleSyntax": true`、`"declaration": true` を設定する。
- 全 package.json に `"type": "module"` を置く。CommonJS 出力の設定を書かない。
- `.node-version` は `22`。`package.json` の `engines.node` は `>=22 <23`。
- `.npmrc` に `save-exact=true` と `engine-strict=true` を置く（DEC-ID-02 の exact ピン留めのため）。
- ルート `package.json` の scripts に `typecheck`（`tsc -b`）、`lint`、`test:unit`、`test:integration`、`build`、`check:deps` を定義する。
- `vitest.workspace.ts` に `unit`（`packages/*/test/**/*.spec.ts` と `apps/*/test/*.spec.ts`）と `integration`（`apps/*/test/integration/**/*.spec.ts`）の2プロジェクトを定義する。e2e は Playwright 側で管理し vitest に含めない。
- ESLint は flat config とし、`@typescript-eslint` の推奨に加えて `no-restricted-imports` の枠だけ用意する（中身は T-PKG-27 で埋める）。
- Prettier を導入しない。整形は ESLint の範囲に留める。

**完了条件**
- [ ] `pnpm install` が lockfile 更新なしで完了する（`pnpm install --frozen-lockfile` が成功する）。
- [ ] `pnpm typecheck` が終了コード 0 で完了する。
- [ ] `pnpm test:unit` が「テスト0件」ではなく、最低1件のプレースホルダテストを実行して成功する。
- [ ] `node -e "process.exit(require('node:fs').readFileSync('.npmrc','utf8').includes('save-exact=true')?0:1)"` が 0 を返す。

---

### T-PKG-02 外部依存の許可リストと依存検査スクリプトを作る

**概要**
DEC-APP-08 は外部依存を許可リストで固定し、JWT 検証と JWS 署名と DPoP と JWK Thumbprint と base64url を自前実装すると決めている。
これを人手のレビューではなくスクリプトで固定する。
禁止依存の混入と、キャレット付きバージョンの混入を CI で落とす。

**対象要件** REQ-08-032
**前提タスク** T-PKG-01
**成果物**
- `scripts/allowed-deps.json`
- `scripts/check-deps.mjs`

**実装方針**
- `allowed-deps.json` に `runtime` と `dev` の2配列を置く。`runtime` は `hono`、`@hono/node-server`、`ajv`、`ajv-formats`、`json-schema-to-ts`、`yaml`、`@google-cloud/firestore`、`@google-cloud/kms`、`@google-cloud/pubsub`、`@google-cloud/secret-manager`、`@google-cloud/storage`、`@google-cloud/bigquery`、`@google-cloud/run`、`@google-cloud/vertexai`、`@maronn-openid-connect/core`、`@maronn-openid-connect/experimental`、`@maronn-openid-connect/cli` に限定する。
- `check-deps.mjs` は3つの検査を行う。(1) 全 package.json の `dependencies` と `devDependencies` のキーが許可リストに含まれること、(2) すべてのバージョン指定が `^` `~` `*` `x` `>` `<` を含まない厳密値であること、(3) 明示禁止リスト `jose`、`jsonwebtoken`、`node-jose`、`jwks-rsa`、`oidc-provider`、`openid-client`、`firebase`、`firebase-admin` が現れないこと。
- 違反を1件ずつ `package.json のパス / 依存名 / 違反理由` の3項目で標準エラーへ出し、1件でもあれば終了コード 1 を返す。
- 許可リストの追加は `allowed-deps.json` の変更としてレビューに乗る。スクリプトに例外の引数を持たせない。

**完了条件**
- [ ] `node scripts/check-deps.mjs` が現状のリポジトリで終了コード 0 を返す。
- [ ] 任意の package.json に `"jose": "5.0.0"` を一時追加すると終了コード 1 になり、標準エラーに `jose` と違反理由が出る。
- [ ] バージョンを `"hono": "^4.0.0"` に書き換えると終了コード 1 になる。
- [ ] ルート `package.json` の `check:deps` スクリプトからこのスクリプトが実行される。

---

### T-PKG-03 base64url と SHA-256 の基本関数を実装する

**概要**
DPoP、JWS、JWK Thumbprint、`ath` のすべてが base64url と SHA-256 に依存する。
外部ライブラリを使わない方針（DEC-APP-08）のため、この2つを最初に確定させる。
デコードは寛容にせず、不正な入力を例外にする。

**対象要件** なし（DEC-APP-03、DEC-APP-08 に基づく基盤タスク）
**前提タスク** T-PKG-01
**成果物**
- `packages/xaa-crypto/src/base64url.ts`
- `packages/xaa-crypto/src/sha256.ts`
- `packages/xaa-crypto/src/errors.ts`
- `packages/xaa-crypto/test/base64url.spec.ts`
- `packages/xaa-crypto/test/sha256.spec.ts`

**実装方針**
- `errors.ts` に `class XaaCryptoError extends Error` を定義し、`code` プロパティを持たせる。コード値は `invalid_base64url`、`invalid_jws_header`、`invalid_signature`、`invalid_jwk`、`invalid_dpop_proof`、`replayed_dpop_proof`、`dpop_key_binding_mismatch`、`cnf_required`、`kms_signature_format` の9種に固定する。
- `base64url.ts` は `encodeBase64Url(input: Uint8Array | string): string` と `decodeBase64Url(value: string): Uint8Array` と `decodeBase64UrlToString(value: string): string` を export する。
- エンコードはパディング `=` を必ず除去する。デコードは `^[A-Za-z0-9_-]*$` に一致しない文字列、および `=` を含む文字列を `XaaCryptoError('invalid_base64url')` で拒否する。
- 実装は `Buffer.from(value, 'base64url')` を使ってよいが、上記の形式検査を Buffer へ渡す前に自前で行う（Buffer は不正文字を黙って読み飛ばすため）。
- `sha256.ts` は `sha256(input: Uint8Array | string): Promise<Uint8Array>` と `sha256Base64Url(input): Promise<string>` を export し、`node:crypto` の `webcrypto.subtle.digest('SHA-256', ...)` を使う。`createHash` を使わない（Cloudflare Workers 互換を残すため）。
- 文字列入力は常に UTF-8 として `TextEncoder` で符号化する。エンコーディングを引数で選ばせない。

**完了条件**
- [ ] `pnpm --filter @xaa/crypto test` の `base64url.spec.ts` が RFC 4648 §10 の3ベクタ（`f`、`fo`、`foobar`）で往復一致する。
- [ ] `decodeBase64Url('aGVsbG8=')` と `decodeBase64Url('aGVs bG8')` がいずれも `XaaCryptoError` を投げ、`code === 'invalid_base64url'` である。
- [ ] `sha256Base64Url('')` が `47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU` を返す。
- [ ] `packages/xaa-crypto/src/` を `require(` で grep して0件である。

---

### T-PKG-04 ES256 鍵ペア生成と JWK 変換を実装する

**概要**
DPoP の Agent 側鍵、Agent Client Credential の鍵、テスト用の署名鍵をすべて同じ生成関数から作る。
公開鍵の JWK 表現を1つに定め、Thumbprint と JWKS 掲載の入力を揃える。
DEC-ID-12 の「ES256 鍵ペア生成」に対応する。

**対象要件** なし（DEC-ID-12 の5機能のうち鍵生成に対応）
**前提タスク** T-PKG-03
**成果物**
- `packages/xaa-crypto/src/keys.ts`
- `packages/xaa-crypto/test/keys.spec.ts`

**実装方針**
- `generateEs256KeyPair(): Promise<Es256KeyPair>` を export する。`Es256KeyPair` は `{ privateKey: CryptoKey; publicKey: CryptoKey; publicJwk: PublicJwkEs256 }`。
- `PublicJwkEs256` 型は `{ kty: 'EC'; crv: 'P-256'; x: string; y: string; alg?: 'ES256'; use?: 'sig'; kid?: string }` とする。RFC 7638 の対象メンバー以外を型に含めない。
- 生成は `webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])`。秘密鍵の `extractable` はテスト用途のため true にするが、`exportPrivateJwk` は `packages/xaa-crypto/src/testing/` 配下にのみ置き、パッケージのルート index から export しない。
- `importPublicJwk(jwk: unknown): Promise<CryptoKey>` は `kty !== 'EC'` または `crv !== 'P-256'` または `x` `y` が文字列でない場合に `XaaCryptoError('invalid_jwk')` を投げる。
- `toPublicJwk(key: CryptoKey): Promise<PublicJwkEs256>` は subtle の export 結果から `kty` `crv` `x` `y` の4つだけを取り出し、`d` を持つオブジェクトが渡された場合は `invalid_jwk` を投げる。
- kid の採番はこの関数の責務にしない。kid は署名器（T-PKG-13、T-PKG-15）が与える。

**完了条件**
- [ ] `keys.spec.ts::generates P-256 key pair with 4-member public jwk` が緑で、`Object.keys(publicJwk).sort()` が `['crv','kty','x','y']` である。
- [ ] `d` を含む JWK を `toPublicJwk` へ渡すと `XaaCryptoError` で `code === 'invalid_jwk'` になる。
- [ ] `importPublicJwk({ kty: 'RSA', n: '...', e: 'AQAB' })` が `invalid_jwk` を投げる。
- [ ] `packages/xaa-crypto/src/index.ts` に `exportPrivateJwk` の re-export が無いことを `grep` で確認する。

---

### T-PKG-05 RFC 7638 の JWK Thumbprint を実装する

**概要**
DPoP の `jkt`、ID-JAG の `cnf.jkt`、Agent Registration の `jwk_thumbprint` はすべて同じ計算に依存する。
計算がずれると DEC-ID-14 の PoP 照合が成立しないため、独立したタスクとして固定する。
DEC-ID-12 の「RFC 7638 Thumbprint」に対応する。

**対象要件** REQ-05-077
**前提タスク** T-PKG-03, T-PKG-04
**成果物**
- `packages/xaa-crypto/src/thumbprint.ts`
- `packages/xaa-crypto/test/thumbprint.spec.ts`
- `packages/xaa-crypto/test/fixtures/ec-thumbprint-vector.json`

**実装方針**
- `jwkThumbprint(jwk: PublicJwkEs256): Promise<string>` を export する。戻り値は base64url 文字列。
- 正規化は RFC 7638 §3.2 に従い、EC 鍵では `crv`、`kty`、`x`、`y` の辞書順のみを含める。`JSON.stringify` にキー配列を渡すのではなく、`{crv, kty, x, y}` の順で明示的にオブジェクトリテラルを構築して `JSON.stringify` する。
- 空白と改行を挟まない。`alg` `use` `kid` を含めない。
- `kty` が `EC` 以外、または `crv` が `P-256` 以外の場合は `XaaCryptoError('invalid_jwk')` を投げる。RSA 分岐を実装しない。
- 検証ベクタは `ec-thumbprint-vector.json` に JWK と期待値の組を1件コミットし、テストで参照する。値は実装後に生成するのではなく、実装前に別実装で算出した値を置く。

**完了条件**
- [ ] `thumbprint.spec.ts::matches committed EC vector` がフィクスチャの期待値とバイト一致する。
- [ ] 同じ鍵に `kid` と `use` を追加しても Thumbprint が変わらないテストが緑。
- [ ] `x` と `y` を入れ替えた JWK が異なる Thumbprint を返す。
- [ ] RSA JWK を渡すと `invalid_jwk` を投げる。

---

### T-PKG-06 JOSE ヘッダ許可リスト付きの ES256 JWS 署名と検証を実装する

**概要**
自前の JWS Compact 実装を1か所に置く。
ヘッダの許可リストを署名検証より前に適用し、`jku` や `jwk` や `x5u` や `x5c` を持つトークンを鍵解決の前に落とす。
REQ-05-069 が求める actor_token のヘッダ拒否は、この層で満たす。

**対象要件** REQ-05-069, REQ-05-033
**前提タスク** T-PKG-03, T-PKG-04
**成果物**
- `packages/xaa-crypto/src/jws.ts`
- `packages/xaa-crypto/test/jws.spec.ts`

**実装方針**
- `signCompactJws(input: { header: JwsHeader; payload: Record<string, unknown>; signer: Es256Signer }): Promise<string>` を export する。`Es256Signer` は `{ kid: string; sign(data: Uint8Array): Promise<Uint8Array> }` で、戻り値は raw R||S の 64 バイト。
- `JwsHeader` は `{ alg: 'ES256'; typ: string; kid?: string; jwk?: PublicJwkEs256 }` に限定する。`jwk` を許すのは DPoP Proof のみで、`allowEmbeddedJwk: boolean`（既定 false）のオプションで制御する。
- `verifyCompactJws(token: string, options: { publicKey: CryptoKey; allowedTyp: readonly string[]; allowEmbeddedJwk?: boolean }): Promise<{ header: JwsHeader; payload: Record<string, unknown> }>` を export する。
- 検証は次の順で行う。(1) ドット区切りが2個であること、(2) ヘッダのデコードと JSON パース、(3) ヘッダのキー集合が `alg` `typ` `kid` `jwk` の部分集合であること（`jku` `x5u` `x5c` `x5t` `x5t#S256` `crit` `enc` `zip` を含めば `invalid_jws_header`）、(4) `allowEmbeddedJwk` が false のとき `jwk` があれば `invalid_jws_header`、(5) `alg === 'ES256'`、(6) 署名検証、(7) `allowedTyp` に `typ` が含まれること。
- 署名検証失敗は `XaaCryptoError('invalid_signature')`。ヘッダ違反は `invalid_jws_header`。両者を同じコードにまとめない。
- `decodeJwsUnverified(token)` も export するが、JSDoc に「ログ出力とテスト以外で使わない」と明記し、関数名に `Unverified` を必ず含める。
- `alg: 'none'` を受理する分岐を実装しない。

**完了条件**
- [ ] `jws.spec.ts::rejects jku header before signature verification` が緑で、署名検証用のモック鍵の呼び出し回数が 0 である。
- [ ] `jws.spec.ts::rejects x5c / x5u / crit headers` が3ケースとも `invalid_jws_header` を返す。
- [ ] `jws.spec.ts::rejects alg none` が `invalid_jws_header` を返す。
- [ ] `verifyCompactJws` に `allowedTyp: ['oauth-id-jag+jwt']` を与えて `typ: 'JWT'` のトークンを渡すと例外になる。
- [ ] 正しい鍵で署名したトークンの往復が成功し、`header.kid` が signer の `kid` と一致する。

---

### T-PKG-07 typ 別の JWT 検証関数を3つに分けて実装する

**概要**
共有 issuer と共有 JWKS の下では ID Token と Access Token と ID-JAG が同じ `iss` に並ぶ（DEC-ID-18）。
取り違えを防ぐため、汎用の `verifyJwt` をルートから呼ばせず、許容する `iss` と `typ` を関数内に固定した3関数だけを公開する。
REQ-01-016 の実装本体をここに置く。

**対象要件** REQ-01-016
**前提タスク** T-PKG-06, T-PKG-08
**成果物**
- `packages/xaa-crypto/src/verifiers.ts`
- `packages/xaa-crypto/test/verifiers.spec.ts`

**実装方針**
- export するのは `verifyHumanAccessToken`、`verifyIdJag`、`verifyGoogleServiceIdentity` の3関数のみ。内部ヘルパは `verifyJwtInternal` という名前にし、`packages/xaa-crypto/src/index.ts` から re-export しない。
- `verifyHumanAccessToken(token, { issuer, jwks, audience })`：`typ` を `at+jwt` に固定し、`iss === issuer` をバイト一致で検査、`aud` は T-PKG-17 の `audienceIncludes` で要素一致判定する。
- `verifyIdJag(token, { issuer, jwks, audience, resource })`：`typ` を `oauth-id-jag+jwt` に固定する。`iss === issuer`、`aud === audience` をバイト一致で検査する。`typ` が `JWT` や `at+jwt` のトークンは `invalid_jws_header` で落ちる。
- `verifyGoogleServiceIdentity(token, { audience })`：`iss` を `https://accounts.google.com` に固定し、JWKS は `https://www.googleapis.com/oauth2/v3/certs` から取る。この関数だけ `alg: 'RS256'` を許容するため、`jws.ts` ではなく専用の RSASSA-PKCS1-v1_5 検証パスを持たせる。ES256 の検証パスと関数を共有しない。
- 3関数とも `exp` と `nbf` を leeway 60 秒で検査し、失敗時は理由を区別しない固定メッセージ `token verification failed` を持つ例外を投げる。エラーコードは `invalid_signature` に統一する。
- `typ` の検査は署名検証の後、クレーム検査の前に置く（DEC-ID-18）。

**完了条件**
- [ ] `verifiers.spec.ts::verifyIdJag rejects typ JWT id token` が例外を投げる。
- [ ] `verifiers.spec.ts::verifyHumanAccessToken rejects typ oauth-id-jag+jwt` が例外を投げる。
- [ ] 3関数のいずれも、失敗理由（署名不正 / exp 超過 / aud 不一致）にかかわらず同じ `message` を返すことをアサートするテストが緑。
- [ ] `packages/xaa-crypto/src/index.ts` を `verifyJwtInternal` で grep して0件である。

---

### T-PKG-08 共有 JWKS の取得キャッシュを実装する

**概要**
Agent OP と Resource AS は自分の鍵ではなく GCS 上の共有 JWKS で他アプリの署名を検証する（DEC-IAC-13）。
TTL 付きのキャッシュと、未知 kid での即時再取得を1か所に実装する。
DEC-ID-20 の kid 接頭辞による限定もここで扱う。

**対象要件** REQ-05-025
**前提タスク** T-PKG-04
**成果物**
- `packages/xaa-crypto/src/jwks-cache.ts`
- `packages/xaa-crypto/test/jwks-cache.spec.ts`

**実装方針**
- `createJwksCache(options: { url: string; ttlSeconds?: number; minRefetchIntervalSeconds?: number; allowedKidPrefixes?: readonly string[]; fetchImpl?: typeof fetch; now?: () => number }): JwksCache` を export する。
- 既定値は `ttlSeconds = 300`、`minRefetchIntervalSeconds = 10`。
- `JwksCache` は `getKey(kid: string): Promise<CryptoKey>` と `invalidate(): void` を持つ。
- `getKey` の手順は次の順。(1) キャッシュが未取得または TTL 切れなら取得、(2) kid で検索、(3) 見つからず、かつ前回取得から `minRefetchIntervalSeconds` 以上経っていれば1回だけ再取得して再検索、(4) それでも無ければ `XaaCryptoError('invalid_jwk')`。
- `allowedKidPrefixes` が指定された場合、その接頭辞に一致しない kid は JWKS に存在してもキャッシュへ載せない。Agent OP の subject_token 検証は `['idp-']` を渡す（DEC-ID-20）。
- HTTP 取得は `fetchImpl` 経由にし、integration では固定の JWKS を返す実装を差し込めるようにする。`@google-cloud/storage` をこのモジュールから import しない。
- 並行して `getKey` が呼ばれた場合、進行中の取得 Promise を共有して多重取得を避ける。

**完了条件**
- [ ] `jwks-cache.spec.ts::refetches once on unknown kid` で `fetchImpl` の呼び出し回数が 2 になる。
- [ ] 未知 kid を連続10回要求しても `fetchImpl` の呼び出し回数が 2 を超えない（`minRefetchIntervalSeconds` が効く）。
- [ ] `allowedKidPrefixes: ['idp-']` を与えたとき、JWKS に含まれる `op-shared-1` の取得が `invalid_jwk` になる。
- [ ] TTL 経過後の最初の `getKey` で再取得が起き、経過前は起きない。

---

### T-PKG-09 DPoP Proof の生成を実装する

**概要**
Agent Runtime と Automation App が送る DPoP Proof を生成する。
DEC-ID-12 は Access Token と併用する Proof に `ath` を必須にすると定めているため、`ath` の省略を実装レベルで防ぐ。
DEV-01 の代替実装の一部になる。

**対象要件** REQ-05-074
**前提タスク** T-PKG-05, T-PKG-06
**成果物**
- `packages/xaa-crypto/src/dpop.ts`（生成部）
- `packages/xaa-crypto/test/dpop.spec.ts`（生成のテストケース）

**実装方針**
- `createDpopProof(input: { method: string; url: string; keyPair: Es256KeyPair; accessToken?: string; nonce?: string; now?: () => number }): Promise<string>` を export する。
- ヘッダは `{ alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwk }`。`kid` を入れない。
- クレームは `jti`（`crypto.randomUUID()`）、`htm`（method を大文字化）、`htu`（正規化後の URL）、`iat`（秒）、`accessToken` があれば `ath`（`sha256Base64Url(accessToken)`）、`nonce` があれば `nonce`。
- `htu` の正規化関数 `normalizeHtu(url: string): string` を同ファイルに置く。scheme と host を小文字化し、クエリとフラグメントを除去し、既定ポート（https の 443、http の 80）を除去する。パス末尾のスラッシュは正規化しない。
- `createDpopProof` は `accessToken` が空文字列の場合に `XaaCryptoError('invalid_dpop_proof')` を投げる。undefined の場合のみ `ath` なしを許す。
- Access Token を伴う経路で `ath` を落とせないよう、上位に `createDpopProofForResource(input & { accessToken: string })` を別 export として用意し、Agent Runtime と Resource アクセス側にはこちらだけを使わせる。

**完了条件**
- [ ] `dpop.spec.ts::includes ath when access token is given` で、生成 Proof の `ath` が `sha256Base64Url(accessToken)` と一致する。
- [ ] `normalizeHtu('HTTPS://Example.COM:443/xaa/token?a=1#f')` が `https://example.com/xaa/token` を返す。
- [ ] `createDpopProof` に `accessToken: ''` を渡すと `invalid_dpop_proof` を投げる。
- [ ] 生成 Proof のヘッダのキー集合が `['alg','jwk','typ']` である。

---

### T-PKG-10 DPoP Proof の検証を固定順序で実装する

**概要**
受け取り側の検証を1関数に集約する。
DEC-ID-12 が定めた検証順序（署名、typ、htm、htu、iat 窓、jti 重複、ath 一致）をコード上の順序として固定し、テストで順序自体を確認する。
REQ-09-026 の3種の違反コードをここで区別する。

**対象要件** REQ-05-017, REQ-05-074, REQ-09-026, REQ-05-070
**前提タスク** T-PKG-09, T-PKG-11
**成果物**
- `packages/xaa-crypto/src/dpop.ts`（検証部）
- `packages/xaa-crypto/test/dpop.spec.ts`（検証のテストケース）

**実装方針**
- `verifyDpopProof(proof: string, input: { method: string; url: string; jtiStore: JtiStore; accessToken?: string; iatWindowSeconds?: number; now?: () => number }): Promise<{ jkt: string; jti: string; publicJwk: PublicJwkEs256 }>` を export する。
- `iatWindowSeconds` の既定は 60。`iat` は `now - window` 以上 `now + window` 以下を許容する。
- 検証順序は次のとおりに実装し、途中で失敗したらその時点で例外を投げる。(1) `verifyCompactJws` を `allowEmbeddedJwk: true` かつ `allowedTyp: ['dpop+jwt']` で呼び、ヘッダの `jwk` を鍵として署名検証する、(2) `typ === 'dpop+jwt'`、(3) `htm` が method の大文字と一致、(4) `htu` が `normalizeHtu(url)` と一致、(5) `iat` が窓内、(6) `jtiStore.consume('dpop', jti, ttl)` が true、(7) `accessToken` が与えられていれば `ath === sha256Base64Url(accessToken)`。
- 例外のコードは (1) から (5) と (7) が `invalid_dpop_proof`、(6) が `replayed_dpop_proof`。
- `accessToken` が与えられているのに `ath` クレームが無い場合も `invalid_dpop_proof` にする。`ath` 無しを通す分岐を実装しない。
- `jkt` は検証成功後に `jwkThumbprint(header.jwk)` で算出して返す。
- `cnf.jkt` との照合はこの関数で行わない。呼び出し側の責務として T-PKG-12 のミドルウェアに置く。

**完了条件**
- [ ] `dpop.spec.ts::rejects htu mismatch` が `invalid_dpop_proof` を返す。
- [ ] `dpop.spec.ts::rejects iat out of window` が窓外の過去と未来の両方で `invalid_dpop_proof` を返す。
- [ ] `dpop.spec.ts::rejects replayed jti` が2回目の呼び出しで `replayed_dpop_proof` を返す。
- [ ] `dpop.spec.ts::rejects ath mismatch` が `invalid_dpop_proof` を返す。
- [ ] 署名不正の Proof を渡したとき、`jtiStore.consume` の呼び出し回数が 0 である（順序の検査）。

---

### T-PKG-11 jti 重複排除ストアを実装する

**概要**
DPoP Proof、actor_token、client_assertion の3つがそれぞれ jti の再利用拒否を必要とする（DEC-ID-11、DEC-ID-12、REQ-05-070）。
名前空間付きの1つのインターフェイスにまとめ、インメモリと Firestore の2実装を用意する。
消費は原子的でなければ再送を通してしまうため、Firestore 実装は作成条件付き書き込みで行う。

**対象要件** REQ-05-070, REQ-09-026
**前提タスク** T-PKG-03
**成果物**
- `packages/xaa-crypto/src/jti-store.ts`（インターフェイスとインメモリ実装）
- `packages/gcp/src/firestore-jti-store.ts`
- `packages/xaa-crypto/test/jti-store.spec.ts`
- `packages/gcp/test/firestore-jti-store.spec.ts`

**実装方針**
- `interface JtiStore { consume(namespace: JtiNamespace, jti: string, ttlSeconds: number): Promise<boolean> }`。戻り値 true は初回、false は再利用。例外で再利用を表現しない。
- `type JtiNamespace = 'dpop' | 'actor-token' | 'client-assertion'`。文字列リテラル以外を受け付けない。
- TTL の既定値を定数として同ファイルに置く。`DPOP_JTI_TTL_SECONDS = 120`（iat 窓 60 の2倍）、`ACTOR_TOKEN_JTI_TTL_SECONDS = 360`（最大寿命 300 + leeway 60）、`CLIENT_ASSERTION_JTI_TTL_SECONDS = 360`。
- `InMemoryJtiStore` は `Map<string, number>` に `${namespace}:${jti}` を鍵、失効時刻を値として持つ。`consume` の先頭で失効済みエントリを掃除する。プロセス跨ぎでは共有されない旨を JSDoc に書く。
- `FirestoreJtiStore` はコレクション `jti_locks`、ドキュメント ID を `${namespace}__${jti}`（`/` と `.` を含まないようエンコード）とし、`create()` を使って既存があれば `ALREADY_EXISTS` を捕捉して false を返す。`set()` を使わない。
- ドキュメントに `expireAt: Timestamp` を持たせ、Firestore の TTL ポリシーで削除させる（ポリシー自体は infra 領域の Terraform で作る）。アプリから削除ジョブを回さない。
- Cloud Run は複数インスタンスで動くため、`SIGNER_MODE` と同様に `STORE_MODE=gcp` のとき Firestore 実装を選ぶ。unit テストではインメモリを使う。

**完了条件**
- [ ] `jti-store.spec.ts::in-memory consume returns false on second call` が緑。
- [ ] `jti-store.spec.ts::namespaces are isolated` で、同じ jti を `dpop` と `actor-token` で消費したとき両方 true になる。
- [ ] TTL 経過後に同じ jti が再び true を返すテストが緑（`now` の注入で時刻を進める）。
- [ ] `firestore-jti-store.spec.ts::returns false on ALREADY_EXISTS` が Firestore エミュレータ上で緑（`STORE_MODE=emulator`）。

---

### T-PKG-12 DPoP 検証の Hono ミドルウェアを実装する

**概要**
DEC-ID-13 の3経路（Agent Runtime から Agent OP、Agent Runtime から Resource、Automation App から Control Plane）で同じミドルウェアを使う。
Access Token の `cnf.jkt` と Proof の Thumbprint の一致確認（RULE-44）をここで行い、`dpop_key_binding_mismatch` を区別する。
Bearer スキームのリクエストを受理しない。

**対象要件** REQ-09-026, REQ-05-074
**前提タスク** T-PKG-10
**成果物**
- `packages/xaa-crypto/src/dpop-middleware.ts`
- `packages/xaa-crypto/test/dpop.spec.ts`（ミドルウェアのテストケース）

**実装方針**
- `createDpopMiddleware(options: { jtiStore: JtiStore; requireAccessToken: boolean; resolveBoundJkt?: (accessToken: string) => Promise<string | undefined>; iatWindowSeconds?: number }): MiddlewareHandler` を export する。
- 処理順は次のとおり。(1) `Authorization` ヘッダのスキームが `DPoP` でなければ 401 と `WWW-Authenticate: DPoP error="invalid_token"`、(2) `DPoP` ヘッダが無ければ 400 と `{"error":"invalid_dpop_proof"}`、(3) `DPoP` ヘッダが2個以上あれば 400、(4) `verifyDpopProof` を実際の到達 URI で呼ぶ、(5) `requireAccessToken` が true なら `resolveBoundJkt` で得た `cnf.jkt` と Proof の `jkt` を比較し、不一致なら 401 と `{"error":"dpop_key_binding_mismatch"}`。
- 到達 URI は `c.req.url` をそのまま使わず、環境変数 `PUBLIC_BASE_URL` とリクエストパスから組み立てる。Cloud Run の内部ホスト名と発行 URL が異なる場合に `htu` が壊れないようにする。
- 検証結果を `c.set('dpop', { jkt, jti })` に置く。ログ出力はこのミドルウェアで行わない（構造化ログはアプリ側の責務、REQ-09-038）。
- 違反時は `c.set('protocolViolationCode', code)` を設定してから応答を返す。アプリ側のログミドルウェアがこれを読む。
- `Bearer` を許容する設定フラグを作らない。

**完了条件**
- [ ] `dpop.spec.ts::rejects Bearer scheme` が 401 と `WWW-Authenticate: DPoP` を返す。
- [ ] `dpop.spec.ts::rejects proof signed by other key as dpop_key_binding_mismatch` が 401 と `{"error":"dpop_key_binding_mismatch"}` を返す。
- [ ] `DPoP` ヘッダ欠落が 400 と `{"error":"invalid_dpop_proof"}` を返す。
- [ ] 成功時に `c.get('dpop').jkt` が Proof の jwk の Thumbprint と一致する。

---

### T-PKG-13 KMS の ES256 署名アダプタと DER から R||S への変換を実装する

**概要**
ID-JAG の署名は Cloud KMS の `asymmetricSign` のみで行う（DEC-ID-16、REQ-08-032）。
KMS は DER 符号化の ECDSA 署名を返すため、JOSE が求める raw R||S 64 バイトへ変換する。
KMS クライアントを呼ぶ箇所をこのファイル1つに閉じる。

**対象要件** REQ-08-032, REQ-08-031
**前提タスク** T-PKG-03
**成果物**
- `packages/xaa-crypto/src/kms-signer.ts`
- `packages/xaa-crypto/src/der.ts`
- `packages/xaa-crypto/test/der.spec.ts`
- `packages/xaa-crypto/test/kms-signer.spec.ts`

**実装方針**
- `der.ts` に `derToRawEcdsaSignature(der: Uint8Array, coordinateBytes: number): Uint8Array` を実装する。SEQUENCE と2つの INTEGER をパースし、先頭の 0x00 パディングを除去し、`coordinateBytes` に左ゼロ詰めして連結する。長さが `coordinateBytes` を超える場合は `XaaCryptoError('kms_signature_format')`。
- タグが 0x30 でない、長さフィールドが不整合、INTEGER が2個でない場合もすべて `kms_signature_format` にする。
- `kms-signer.ts` に `createKmsEs256Signer(options: { keyVersionName: string; kidPrefix: string; client?: KeyManagementServiceClient }): Es256Signer` を実装する。
- `sign(data)` は `sha256(data)` をローカルで計算し、`client.asymmetricSign({ name: keyVersionName, digest: { sha256 } })` を呼ぶ。`data` そのものを KMS へ送らない。
- 応答の `signature` を `derToRawEcdsaSignature(sig, 32)` へ通して返す。
- `kid` は `deriveKid(kidPrefix, keyVersionName)` で決める。`keyVersionName` の末尾のバージョン番号を取り出し、`${kidPrefix}-${version}` を返す（例：`op-shared-1`、`idjag-aaaaaaaaaaaa-1`）。
- `@google-cloud/kms` の import をこのファイル以外に書かない。`asymmetricSign` の呼び出しもこの1か所に限る。
- `getPublicKey` は同ファイルに `fetchKmsPublicJwk(keyVersionName): Promise<PublicJwkEs256>` として置き、JWKS 生成にのみ使う旨を JSDoc に書く。

**完了条件**
- [ ] `der.spec.ts::pads short r and s to 32 bytes` が、r が 31 バイトの DER 署名で 64 バイトを返す。
- [ ] `der.spec.ts::strips leading zero padding` が、先頭 0x00 付き 33 バイト INTEGER で 64 バイトを返す。
- [ ] `der.spec.ts::rejects non-sequence input` が `kms_signature_format` を投げる。
- [ ] `kms-signer.spec.ts::sends digest not raw data` で、モック KMS が受け取った `digest.sha256` が `sha256(data)` と一致し、`data` フィールドが未設定である。
- [ ] `grep -rn "asymmetricSign" packages/ apps/ --include=*.ts | grep -v test` の結果が `packages/xaa-crypto/src/kms-signer.ts` の1件だけである。

---

### T-PKG-14 signIdJag を1関数へ集約し typ と cnf を強制する

**概要**
ID-JAG 署名鍵で `oauth-id-jag+jwt` 以外を署名させない（RULE-48、REQ-10-007）。
同時に、cnf を持たない ID-JAG を発行する経路を作らない（DEC-ID-08、REQ-05-079）ため、cnf 不在を署名器側で拒否する。
Agent OP のルートはこの関数だけを呼ぶ。

**対象要件** REQ-08-031, REQ-10-007, REQ-05-033, REQ-05-079
**前提タスク** T-PKG-06, T-PKG-13
**成果物**
- `packages/xaa-crypto/src/sign-id-jag.ts`
- `packages/xaa-crypto/test/sign-id-jag.spec.ts`

**実装方針**
- シグネチャは `signIdJag(claims: Record<string, unknown>, signer: Es256Signer): Promise<string>` に固定する。`typ` を引数で受け取らない。
- 関数内で `const typ = 'oauth-id-jag+jwt'` を定数として持ち、`signCompactJws` へ `{ alg: 'ES256', typ, kid: signer.kid }` を渡す。
- 署名前に3つのガードを置く。(1) `claims.cnf` がオブジェクトで `claims.cnf.jkt` が空でない文字列でなければ `XaaCryptoError('cnf_required')`、(2) `claims.iss` `claims.sub` `claims.aud` `claims.exp` `claims.iat` `claims.jti` がいずれも存在すること、(3) `claims.exp` が数値かつ `claims.iat` より大きいこと。
- 引数型を `Record<string, unknown>` にすることで、`buildIdJagClaims` の戻り値をスプレッドして `cnf` を足したオブジェクトを型 cast なしで渡せるようにする（DEC-ID-08）。
- ID Token や Access Token を署名する関数をこのパッケージに置かない。`signIdJag` 以外に `Es256Signer` を受ける公開関数を作らない（テスト用の `signForTest` は `src/testing/` へ隔離する）。

**完了条件**
- [ ] `sign-id-jag.spec.ts::signature accepts no typ argument` が `signIdJag.length === 2` をアサートする。
- [ ] `sign-id-jag.spec.ts::always emits typ oauth-id-jag+jwt` が、生成 JWT のヘッダをデコードして `typ` を確認する。
- [ ] `sign-id-jag.spec.ts::never signs without cnf` が、`cnf` を落とした claims で `cnf_required` を投げ、signer の `sign` 呼び出し回数が 0 である。
- [ ] `cnf: { jkt: '' }` でも `cnf_required` になる。

---

### T-PKG-15 SIGNER_MODE による署名器の切替とローカル署名器を実装する

**概要**
unit と integration では KMS を呼べないため、同じ `Es256Signer` インターフェイスのローカル実装を用意する（DEC-APP-09）。
本番相当の構成で誤ってローカル署名器が選ばれないよう、起動時のガードを置く。

**対象要件** REQ-08-032
**前提タスク** T-PKG-13, T-PKG-24
**成果物**
- `packages/xaa-crypto/src/signer-factory.ts`
- `packages/xaa-crypto/src/local-signer.ts`
- `packages/xaa-crypto/test/signer-factory.spec.ts`

**実装方針**
- `createLocalEs256Signer(input: { privateKey: CryptoKey; kid: string }): Es256Signer` を実装する。`webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ...)` は raw R||S を返すため変換は不要。
- `createSignerFromEnv(env: NodeJS.ProcessEnv): Promise<Es256Signer>` を実装し、`SIGNER_MODE` が `kms` なら `createKmsEs256Signer({ keyVersionName: env.KMS_KEY_VERSION, kidPrefix: env.KID_PREFIX })`、`local` なら `LOCAL_SIGNING_JWK`（base64url 化した JWK 文字列）から鍵を import する。
- `SIGNER_MODE` が `local` かつ `NODE_ENV === 'production'` の場合は起動時に例外を投げる。回避用の環境変数を作らない。
- `SIGNER_MODE` が `local` でも `kms` でもない場合は例外を投げる。既定値へのフォールバックを実装しない。
- `local-signer.ts` から `@google-cloud/kms` を import しない。`signer-factory.ts` の KMS 分岐は動的 import にして、`SIGNER_MODE=local` のプロセスが KMS クライアントを読み込まないようにする。

**完了条件**
- [ ] `signer-factory.spec.ts::throws on local signer in production` が例外を投げる。
- [ ] `signer-factory.spec.ts::throws on unknown SIGNER_MODE` が `SIGNER_MODE=fake` で例外を投げる。
- [ ] ローカル署名器が生成した JWT を `verifyCompactJws` が検証できる往復テストが緑。
- [ ] `SIGNER_MODE=local` で `createSignerFromEnv` を呼んだ後、`require.cache` 相当の動的 import 記録に `@google-cloud/kms` が現れないことをアサートする。

---

### T-PKG-16 識別子の定数表を1ファイルに置く

**概要**
Capability 8件、Resource AS の scope 7件、Tool ID 8件、typ と grant_type と token_type を1ファイルに集約する（DEC-SCOPE-03、specs 5.0）。
別名を作らせないために、リテラル文字列がこのファイル以外に現れないことを静的検査で固定する。
Tool ID から Capability と scope への対応表もここに置く。

**対象要件** なし（DEC-SCOPE-03 と specs 5.0 の命名確定に対応）
**前提タスク** T-PKG-01
**成果物**
- `packages/xaa-contracts/src/identifiers.ts`
- `packages/xaa-contracts/test/identifiers.spec.ts`
- `scripts/check-identifier-aliases.mjs`

**実装方針**
- `CAPABILITIES` に8件を `as const` 配列で置く。値は `calendar.event.read`、`calendar.event.write`、`mail.message.read`、`mail.message.send`、`document.read`、`document.write`、`finance.payment.read`、`finance.payment.approve`。
- `RESOURCE_SCOPES` に `docs.read`、`docs.write`、`finance.tx.read`、`finance.tx.write`、`calendar.read`、`gmail.read`、`gmail.send` を置く。
- `TOOL_IDS` に `internal.document.list`、`internal.document.get`、`internal.document.create`、`internal.document.update`、`internal.finance.payment.list`、`internal.finance.payment.get`、`internal.finance.payment.approve`、`stub.calendar.events.list` を置く。
- `TOOL_BINDINGS: Record<ToolId, { capability: Capability; scope: ResourceScope; method: 'GET'|'POST'|'PATCH'; pathTemplate: string }>` を specs 5.1 と 5.2 の表どおりに置く。
- `JWT_TYP` に `ID_TOKEN: 'JWT'`、`ACCESS_TOKEN: 'at+jwt'`、`ID_JAG: 'oauth-id-jag+jwt'`、`DPOP_PROOF: 'dpop+jwt'`、`ACTOR_TOKEN: 'agent-assertion+jwt'`、`CLIENT_ASSERTION: 'agent-client-auth+jwt'` を置く。
- `assertValidCapabilityId(value: string): void` を実装する。`^[a-z]+(\.[a-z]+){1,2}$` に一致し、`google` `microsoft` `github` `slack` `get` `post` `put` `patch` `delete` のいずれのセグメントも含まないことを検査する。違反は `Error` を投げる。
- 型は `type Capability = (typeof CAPABILITIES)[number]` のように配列から導く。手書きの union を別に書かない。
- `check-identifier-aliases.mjs` は、上記のリテラル文字列が `packages/xaa-contracts/src/identifiers.ts` と `test/` と `demo-scenarios/` と `docs/` 以外のソースにハードコードされていないかを grep で検査する。定数経由の参照だけを許す。

**完了条件**
- [ ] `identifiers.spec.ts::capability ids pass format check` が8件すべてで `assertValidCapabilityId` を通す。
- [ ] `identifiers.spec.ts::rejects vendor and method segments` が `google.calendar.read` と `document.get` で例外になる。
- [ ] `TOOL_BINDINGS` のキー集合が `TOOL_IDS` と完全一致するテストが緑。
- [ ] `node scripts/check-identifier-aliases.mjs` が終了コード 0 を返し、任意のアプリに `'docs.read'` を直書きすると 1 を返す。

---

### T-PKG-17 audience 判定と grant_type の契約を実装する

**概要**
core の `buildAccessTokenAudience` が `${issuer}/userinfo` を常に付けるため `aud` は2要素以上になる（DEV-12）。
判定を「要素として含まれるか」に固定し、部分一致を実装しない。
あわせて grant_type と token_type の定数をライブラリから再輸出し、`jwt-dpop` のような存在しない値を書けないようにする（DEV-06）。

**対象要件** REQ-05-052
**前提タスク** T-PKG-16
**成果物**
- `packages/xaa-contracts/src/audience.ts`
- `packages/xaa-contracts/src/grant-types.ts`
- `packages/xaa-contracts/test/audience.spec.ts`
- `packages/xaa-contracts/test/grant-types.spec.ts`

**実装方針**
- `audienceIncludes(aud: unknown, self: string): boolean` を実装する。`aud` が文字列なら `aud === self`、配列なら要素の厳密一致で判定する。それ以外の型は false。
- 前方一致、後方一致、`includes`、正規表現を実装しない。末尾スラッシュの正規化も行わない（issuer は locals で決定論的に組み立てるため揺れない、DEC-IAC-05）。
- `grant-types.ts` は `@maronn-openid-connect/experimental/id-jag` から `JWT_BEARER_GRANT_TYPE`、`TOKEN_EXCHANGE_GRANT_TYPE`、`ID_JAG_TOKEN_TYPE`、`TOKEN_TYPE_ID_TOKEN`、`TOKEN_TYPE_JWT`、`TOKEN_TYPE_REFRESH_TOKEN` を import して re-export する。文字列を自前で書かない。
- 加えて `CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'` を定義する（これは IANA 登録値で、ライブラリに定数が無いため自前で置く）。
- `REJECTED_SUBJECT_TOKEN_TYPES = [TOKEN_TYPE_REFRESH_TOKEN] as const` を置き、Agent OP が `subject_token_type=refresh_token` を `invalid_request` で拒否する根拠（REQ-05-052、DEC-ID-19）をこの定数に置く。
- `grant_type` の文字列を `apps/` 配下に直書きさせない。T-PKG-16 の alias 検査対象に grant_type の値も追加する。

**完了条件**
- [ ] `audience.spec.ts::element match, no prefix/substring match` が、`aud: ['https://a.example', 'https://a.example/userinfo']` に対し `self='https://a.example'` で true、`self='https://a.example/user'` で false、`self='https://a'` で false を返す。
- [ ] `audience.spec.ts::rejects non-string non-array aud` が `null` と `{}` と `42` で false を返す。
- [ ] `grant-types.spec.ts::JWT_BEARER_GRANT_TYPE equals urn:ietf:params:oauth:grant-type:jwt-bearer` が緑。
- [ ] `grep -rn "jwt-dpop" apps/ packages/ --include=*.ts` が0件である。

---

### T-PKG-18 actor_token の契約を実装する

**概要**
actor_token は本システム独自プロファイルで、`actor_token_type` と `typ` と `act.sub` の名前空間を固定する（DEC-ID-10、DEV-03）。
Agent OP と Resource AS が同じ判定を使えるよう、契約と正規化関数を共有パッケージへ置く。
他 Agent の actor_token を作れないこと（REQ-05-044）の照合材料もここで定義する。

**対象要件** REQ-05-067, REQ-05-044
**前提タスク** T-PKG-16, T-PKG-17
**成果物**
- `packages/xaa-contracts/src/actor-token.ts`
- `packages/xaa-contracts/test/actor-token.spec.ts`

**実装方針**
- `ACTOR_TOKEN_TYPE` は `TOKEN_TYPE_JWT` の再輸出とする。`ACTOR_TOKEN_TYP = JWT_TYP.ACTOR_TOKEN`（`agent-assertion+jwt`）。
- `AGENT_URN_PREFIX = 'urn:xaa:agent:'` を定義する。`toAgentUrn(agentId: string): string` と `parseAgentUrn(urn: string): string` を実装する。
- `agentId` は `^agent-[0-9a-z-]{8,}$` に一致することを `assertAgentId` で検査する（REQ-01-004 の名前空間分離をこの正規表現で表す）。人間の `sub` がこの形式を取れないことは Human IdP 側の責務なので、ここでは Agent 側の形だけを固定する。
- `ActorTokenClaims` 型を `{ iss: string; sub: string; aud: string; exp: number; iat: number; jti: string }` として定義し、`assertActorTokenClaims(payload: unknown): asserts payload is ActorTokenClaims` を実装する。`iss === sub` であること（どちらも agent_id）を検査に含める。
- `assertActorTokenType(value: unknown): void` は `ACTOR_TOKEN_TYPE` 以外を受けたら `Error` を投げる。`access_token` 系や SAML 系を通す分岐を書かない。
- actor_token の署名検証そのものはここに置かない。ヘッダ拒否は T-PKG-06、鍵の解決は Agent OP の責務。
- `ACTOR_TOKEN_MAX_LIFETIME_SECONDS = 300` を定義し、T-PKG-11 の TTL 定数と対応させる。

**完了条件**
- [ ] `actor-token.spec.ts::rejects non-jwt actor_token_type` が `urn:ietf:params:oauth:token-type:access_token` と `urn:ietf:params:oauth:token-type:saml2` の両方で例外になる。
- [ ] `actor-token.spec.ts::rejects iss and sub mismatch` が例外になる。
- [ ] `toAgentUrn('agent-01hxyz1234')` が `urn:xaa:agent:agent-01hxyz1234` を返し、`parseAgentUrn` が往復する。
- [ ] `assertAgentId('user-456')` が例外になる。

---

### T-PKG-19 OAuth エラー応答の共通表現を実装する

**概要**
REQ-05-068 は、失敗理由ごとに `error_description` が変化しないことを求めている。
ライブラリの `IdJagError` から docs のエラーコードへ写像する処理を各アプリで書き分けると文言が揺れるため、共通化する。
Protocol Validation の違反コード列挙もここに置く。

**対象要件** REQ-05-068
**前提タスク** T-PKG-16
**成果物**
- `packages/xaa-contracts/src/oauth-errors.ts`
- `packages/xaa-contracts/test/oauth-errors.spec.ts`

**実装方針**
- `OAUTH_ERROR_CODES` に `invalid_request`、`invalid_client`、`invalid_grant`、`invalid_scope`、`unauthorized_client`、`unsupported_grant_type`、`invalid_dpop_proof`、`replayed_dpop_proof`、`dpop_key_binding_mismatch`、`insufficient_scope`、`insufficient_isolation`、`constraint_violation`、`tool_not_allowed` を `as const` で置く。
- `oauthErrorResponse(code: OAuthErrorCode, status: number): Response` を実装し、本文を `{ "error": code }` の1キーだけにする。`error_description` を既定で含めない。
- `error_description` が必要な場合は `FIXED_DESCRIPTIONS: Record<OAuthErrorCode, string>` の固定文言のみを使う。呼び出し側から任意文字列を渡す引数を作らない。
- `mapIdJagError(err: unknown): OAuthErrorCode` を実装する。`@maronn-openid-connect/experimental/id-jag` の `IdJagError` を捕捉し、subject_token と actor_token に関する失敗を一律 `invalid_grant` へ、audience と scope と resource の範囲外を `invalid_scope` へ写像する（DEC-ID-06、REQ-09-024）。
- 内部の理由は戻り値に載せない。呼び出し側が構造化ログへ書くための `{ code, internalReason }` を返す形にし、`internalReason` は Response に混ぜない。

**完了条件**
- [ ] `oauth-errors.spec.ts::response body has only error key` が、生成 Response の JSON のキー集合が `['error']` であることをアサートする。
- [ ] `oauth-errors.spec.ts::maps all IdJagError codes to invalid_grant or invalid_scope` が、`IdJagErrorCode` の全値を網羅して写像先を確認する。
- [ ] `oauthErrorResponse` に `internalReason` を渡す引数が存在しないことを型テスト（`@ts-expect-error`）で固定する。
- [ ] 異なる3つの失敗理由から生成した Response の本文がバイト一致する。

---

### T-PKG-20 JSON Schema と Ajv 検証基盤を作る

**概要**
DEC-APP-05 はスキーマを単一の正とし、検証を Ajv、型を json-schema-to-ts で導くと定めている。
スキーマの置き場所、Ajv インスタンスの設定、型の導出方法を1か所に固定する。
Firestore のドキュメント、API のリクエスト本文、seed の入力がすべてこの仕組みを通る。

**対象要件** なし（DEC-APP-05 に基づく基盤タスク）
**前提タスク** T-PKG-16
**成果物**
- `packages/xaa-contracts/src/schema/index.ts`
- `packages/xaa-contracts/src/schema/validator.ts`
- `packages/xaa-contracts/src/schema/agent-registration.schema.ts`
- `packages/xaa-contracts/src/schema/xaa-static-config.schema.ts`
- `packages/xaa-contracts/src/schema/tool-definition.schema.ts`
- `packages/xaa-contracts/src/schema/platform-endpoints.schema.ts`
- `packages/xaa-contracts/test/schema.spec.ts`

**実装方針**
- スキーマは TypeScript ファイル内の `as const` オブジェクトとして書く。`.json` ファイルにしない（json-schema-to-ts の型導出のため）。
- Ajv は `new Ajv({ strict: true, allErrors: false, removeAdditional: false })` で1インスタンスを作り、`ajv-formats` の `date-time` と `uri` と `uuid` を有効にする。`allErrors: true` にしない（エラー本文に内部情報を載せないため）。
- 全スキーマに `additionalProperties: false` と `required` を明記する。省略を許さない。
- `validator.ts` は `compile<S extends JSONSchema>(schema: S): (data: unknown) => asserts data is FromSchema<S>` を export する。検証失敗は `SchemaValidationError`（`schemaId` と `instancePath` を持つ）を投げる。
- `agent-registration.schema.ts` には `agent_id`、`human_subject`、`status`（`ACTIVE` / `EXPIRING` / `QUARANTINED` / `REVOKED`）、`expires_at`、`isolation_level`（`standard` / `full_isolation`）、`dedicated_op`、`client_auth`（`jwk_thumbprint` と `public_jwk`）、`xaa_static_config` への参照を置く。
- `xaa-static-config.schema.ts` には `allowed_audiences`、`resources`、`scopes`、`trusted_resource_as`、`expires_at` を置く（REQ-05-035 の型分離に対応する形を用意する。判定ロジックは Agent OP 側）。
- `platform-endpoints.schema.ts` は DEC-IAC-06 の `platform_endpoints` オブジェクトの形（`issuer` / `jwks_url` / `xaa_token_url` / 各サービス URL）を定義する。httpClient と seed がこのスキーマで読む。
- Ajv インスタンスをアプリごとに作らせない。`packages/xaa-contracts` から `ajv` を import する箇所を `validator.ts` の1件に限る。

**完了条件**
- [ ] `schema.spec.ts::rejects unknown property on agent registration` が `additionalProperties` 違反で `SchemaValidationError` を投げる。
- [ ] `schema.spec.ts::status enum is exhaustive` が4値以外を拒否する。
- [ ] 型テストで `FromSchema<typeof agentRegistrationSchema>['status']` が4値の union になることを `@ts-expect-error` で固定する。
- [ ] `grep -rn "from 'ajv'" packages/ apps/ --include=*.ts` の結果が `validator.ts` の1件だけである。

---

### T-PKG-21 httpClient ラッパを実装する

**概要**
アプリ間の HTTP 呼び出しをすべてこのラッパ経由にする（DEC-APP-07）。
本番では `fetch` で Cloud Run の URL を叩き、integration では対向アプリの `app.fetch` へ差し替える。
宛先は DEC-IAC-06 の `platform_endpoints` から解決し、URL をアプリに直書きしない。

**対象要件** なし（DEC-APP-07、DEC-IAC-06 に基づく基盤タスク）
**前提タスク** T-PKG-20, T-PKG-12
**成果物**
- `packages/xaa-contracts/src/http-client.ts`
- `packages/xaa-contracts/src/service-ids.ts`
- `packages/xaa-contracts/test/http-client.spec.ts`

**実装方針**
- `SERVICE_IDS` を `as const` で定義する。値は `human-idp`、`agent-op`、`agent-op-callback`、`automation-app`、`provisioner`、`authorization`、`lifecycle`、`tool-catalog`、`resource-docs-as`、`resource-docs-api`、`resource-finance-as`、`resource-finance-api`、`stub-saas-op`、`google-bridge`。
- `createHttpClient(options: { endpoints: PlatformEndpoints; transport?: Transport; dpop?: DpopOptions }): HttpClient` を export する。`Transport` は `(serviceId: ServiceId, request: Request) => Promise<Response>`。
- 既定の `Transport` は `endpoints` から baseUrl を引いて `globalThis.fetch` を呼ぶ。Cloud Run の内部呼び出しでは ID Token を付ける必要があるため、`identityTokenProvider?: (audience: string) => Promise<string>` を受け取り、指定時は `Authorization: Bearer <id_token>` を付与する。
- `dpop` が指定された場合、`Authorization` を `DPoP <access_token>` に置き換え、`DPoP` ヘッダに `createDpopProofForResource` で作った Proof を載せる。この経路では Bearer を使わない（DEC-ID-13）。
- `request(serviceId, path, init)` は `path` にテンプレート文字列の直書きを許すが、クエリは `URLSearchParams` を通す。`serviceId` は union 型なので未知のサービス名がコンパイルエラーになる。
- 応答は `Response` をそのまま返す。JSON パースとスキーマ検証は呼び出し側が `validator.ts` で行う。
- `setTransport(transport)` を export し、integration ハーネスが差し替えられるようにする。プロセス起動後の差し替えは1回だけ許し、2回目は例外にする。
- タイムアウトは `AbortSignal.timeout(10_000)` を既定で付ける。無制限の設定を作らない。

**完了条件**
- [ ] `http-client.spec.ts::resolves base url from platform endpoints` が、`endpoints` に無い `serviceId` で例外になる。
- [ ] `http-client.spec.ts::attaches DPoP proof and DPoP scheme` が、`Authorization` が `DPoP ` で始まり `DPoP` ヘッダの `ath` が Access Token の SHA-256 と一致することをアサートする。
- [ ] `setTransport` を2回呼ぶと2回目が例外になる。
- [ ] `grep -rn "run.app" apps/ --include=*.ts` が0件である（URL 直書きの不在）。

---

### T-PKG-22 maronn ライブラリの契約テストを作る

**概要**
DEC-ID-02 はライブラリへの fork とパッチを禁じ、破壊的変更を契約テストで検知すると定めている（DEV-08）。
Agent OP がステップ関数を直接組み替える以上、関数の存在と引数の形と定数値が変わると気付かないまま壊れる。
使用する公開 API を列挙して固定する。

**対象要件** REQ-08-020, REQ-05-052, REQ-05-067
**前提タスク** T-PKG-17, T-PKG-18
**成果物**
- `packages/xaa-contracts/test/library-contract.spec.ts`
- `packages/xaa-contracts/src/library-surface.ts`

**実装方針**
- `library-surface.ts` に、本システムが使う maronn の公開 API を1つずつ named import して re-export する。対象は `@maronn-openid-connect/experimental/id-jag` の `authorizeIdJagIssuanceClient`、`parseIdJagIssuanceParams`、`resolveIdJagSubject`、`resolveIdJagActorToken`、`validateIdJagAudience`、`validateIdJagScope`、`buildIdJagClaims`、`createIdJagJwt`、`buildIdJagIssuanceResponse`、`processIdJagIssuanceRequest`、`parseIdJagRedemptionParams`、`verifyIdJagAssertion`、`authorizeIdJagRedemptionClient`、`resolveIdJagGrantScope`、`IdJagError`、および定数 `ID_JAG_JWT_TYP`、`ID_JAG_TOKEN_TYPE`、`TOKEN_EXCHANGE_GRANT_TYPE`、`JWT_BEARER_GRANT_TYPE`、`TOKEN_TYPE_ID_TOKEN`、`TOKEN_TYPE_JWT`、`TOKEN_TYPE_REFRESH_TOKEN`、`ACTOR_TOKEN_TYPES_SUPPORTED`。
- 契約テストは4種を書く。(1) 上記のすべてが `undefined` でないこと、(2) 関数の `length`（宣言引数の数）が期待値と一致すること、(3) 定数の文字列値がバイト一致すること（`ID_JAG_JWT_TYP === 'oauth-id-jag+jwt'` など）、(4) `verifyIdJagAssertion` が `aud !== options.issuer` の assertion を拒否することを実データで確認すること（DEC-ID-05 の前提の固定）。
- `resolveIdJagActorToken` の入力型に `subject` フィールドが無いことを型テストで固定する（DEC-ID-07 の前提。ここが変われば RULE-49 の実装位置を見直す必要がある）。
- `buildIdJagClaims` の戻り値をスプレッドして `cnf` を追加したオブジェクトが `createIdJagJwt` へ渡せることを型テストで固定する（DEC-ID-08 の前提）。
- ライブラリのバージョンを `package.json` から読み、テスト名にバージョン文字列を含める。バージョンを上げたときにどのバージョンで固定していたかがログに残るようにする。
- 契約テストはモックを使わない。実際の import と実際の関数呼び出しで確認する。

**完了条件**
- [ ] `library-contract.spec.ts` が緑で、24 個の export すべての存在をアサートしている。
- [ ] `library-contract.spec.ts::verifyIdJagAssertion requires aud to equal issuer` が、URN 形式の `aud` で例外になることを確認する。
- [ ] `library-contract.spec.ts::IdJagActorTokenResolverInput has no subject field` が型テストとして緑。
- [ ] `package.json` の maronn 3パッケージのバージョンが `^` を含まない厳密指定である。

---

### T-PKG-23 createApp() 規約と同一プロセス integration ハーネスを作る

**概要**
DEC-APP-07 は、integration を全アプリ同一プロセスで動かし `app.fetch(request)` を直接呼ぶと定めている。
各アプリが従うべき `createApp(): Hono` の規約と、httpClient の transport を対向アプリへ配線するハーネスをここで作る。
複数プロセスを起動する仕組みは作らない。

**対象要件** なし（DEC-APP-07 に基づく基盤タスク）
**前提タスク** T-PKG-21, T-PKG-24
**成果物**
- `packages/xaa-contracts/src/testing/harness.ts`
- `packages/xaa-contracts/src/testing/index.ts`
- `packages/xaa-contracts/src/app-contract.ts`
- `packages/xaa-contracts/test/harness.spec.ts`
- `scripts/check-create-app.mjs`

**実装方針**
- `app-contract.ts` に `export type CreateApp = (deps?: Partial<AppDeps>) => Hono` を定義する。`AppDeps` は `{ httpClient, signer, jtiStore, store, now, logger }`。
- 各アプリの `apps/<name>/src/app.ts` は `createApp` を default export する。`src/server.ts` が `serve({ fetch: createApp().fetch, port })` を呼ぶ。`server.ts` に業務ロジックを置かない。
- `check-create-app.mjs` は `apps/*/src/app.ts` が存在し、default export の名前が `createApp` であることを AST ではなく正規表現 `export default createApp` で検査する。
- `harness.ts` の `createHarness(apps: Partial<Record<ServiceId, CreateApp>>): Harness` は次を行う。(1) 渡されたアプリを `createApp(deps)` で生成、(2) `serviceId` から `Hono` インスタンスへの Map を作る、(3) `setTransport` で「`serviceId` を引いて対応する `app.fetch(request)` を呼ぶ transport」を登録、(4) 未登録の `serviceId` への呼び出しは即座に例外にする（本番 URL へ抜けないようにする）。
- ハーネスは共有の `InMemoryJtiStore` と、テスト用の固定 `now()` と、テスト用ローカル署名器を全アプリへ配る。アプリごとに別インスタンスを作らない。
- `Harness` は `fetch(serviceId, path, init)` と `advanceTime(seconds)` と `dispose()` を持つ。`advanceTime` で有効期限のテストを実時間の待機なしに書けるようにする。
- ネットワークへ出ないことを保証するため、ハーネスの起動時に `globalThis.fetch` を「呼ばれたら失敗するスタブ」へ差し替え、`dispose()` で戻す。

**完了条件**
- [ ] `harness.spec.ts::routes service id to app.fetch` が、2つのダミーアプリ間の呼び出しでネットワークを使わずに応答を得る。
- [ ] `harness.spec.ts::unregistered service id throws` が例外になる。
- [ ] `harness.spec.ts::global fetch is blocked inside harness` で、ハーネス起動中の `globalThis.fetch('https://example.com')` が例外になる。
- [ ] `node scripts/check-create-app.mjs` が終了コード 0 を返し、`apps/` にダミーの `app.ts` を default export 無しで置くと 1 を返す。

---

### T-PKG-24 モード切替の環境変数を1ファイルで定義し起動時に検証する

**概要**
DEC-APP-09 は差し替えを4つの環境変数で行うと定めている。
値の解釈が各アプリでばらつくと、integration では動くが本番で別の実装が選ばれる事故が起きる。
定義と検証を1ファイルに集約し、起動時に fail-fast させる。

**対象要件** なし（DEC-APP-09 に基づく基盤タスク）
**前提タスク** T-PKG-20
**成果物**
- `packages/xaa-contracts/src/modes.ts`
- `packages/xaa-contracts/test/modes.spec.ts`

**実装方針**
- `SIGNER_MODE`（`local` / `kms`）、`VERTEX_MODE`（`fake` / `live`）、`PUBSUB_MODE`（`inproc` / `gcp`）、`STORE_MODE`（`emulator` / `gcp`）の4つだけを扱う。5つ目のモード変数を追加しない。
- `readModes(env: NodeJS.ProcessEnv): Modes` を実装する。未設定は例外。既定値へのフォールバックを実装しない（Terraform が常に明示注入する、DEC-IAC-07）。
- `NODE_ENV === 'production'` のとき、4つすべてが本番側の値（`kms` / `live` は任意、`gcp` / `gcp` は必須）でなければ例外にする。`VERTEX_MODE=fake` は本番でも許す（Vertex を呼ばない検証プロファイルのため）。
- 同ファイルに、モードに依存しない必須環境変数の検証も置く。`ISSUER`、`PUBLIC_BASE_URL`、`PLATFORM_ENDPOINTS_URL`、`KID_PREFIX`、`AGENT_MAX_LIFETIME_SECONDS`、`ID_JAG_LIFETIME_SECONDS`（既定 300）。検証は T-PKG-20 の Ajv スキーマで行う。
- `AGENT_MAX_LIFETIME_SECONDS` は DEC-IAC-16 の単一変数から導出される値なので、アプリ側で別の期限定数を定義しない。
- モード判定の分岐は `switch` で網羅し、`default` で例外を投げる。`if (mode === 'gcp')` の裏側を暗黙の本番扱いにしない。

**完了条件**
- [ ] `modes.spec.ts::throws when SIGNER_MODE is unset` が例外になる。
- [ ] `modes.spec.ts::rejects STORE_MODE=emulator in production` が例外になる。
- [ ] `modes.spec.ts::accepts VERTEX_MODE=fake in production` が例外にならない。
- [ ] `grep -rn "process.env" apps/*/src --include=*.ts` の結果が、各アプリで `modes.ts` の呼び出し以外に現れない。

---

### T-PKG-25 packages/gcp を切り出し Firestore の JsonStoreBackend を実装する

**概要**
生成 OP は `templates.ts` の `JsonStoreBackend` インターフェイス（`get` / `put` / `delete` / `list`）でストアを差し替えられる（DEC-ID-01、DEC-IAC-09）。
これを Firestore で実装し、human-idp と resource-docs-as と resource-finance-as と stub-saas-op の4つが同じ実装を使う。
複数アプリが import するため、DEC-APP-03 の「2つ目のアプリが import したくなった時点で切り出す」規約に沿って3つ目のパッケージ `@xaa/gcp` を作る。

**対象要件** なし（DEC-IAC-09、DEC-ID-01 に基づく基盤タスク）
**前提タスク** T-PKG-11, T-PKG-24
**成果物**
- `packages/gcp/package.json`, `packages/gcp/tsconfig.json`
- `packages/gcp/src/firestore-client.ts`
- `packages/gcp/src/firestore-json-store.ts`
- `packages/gcp/test/firestore-json-store.spec.ts`

**実装方針**
- `firestore-client.ts` に `getFirestore(modes: Modes): Firestore` を置く。`STORE_MODE=emulator` のとき `FIRESTORE_EMULATOR_HOST` を読み、`gcp` のとき既定の認証で接続する。`@google-cloud/firestore` の import をこのパッケージ以外に書かない。
- `createFirestoreJsonStoreBackend(options: { firestore: Firestore; collection: string }): JsonStoreBackend` を実装する。`collection` はアプリごとに異なる値を渡す（`oidc_human_idp`、`oidc_resource_docs_as`、`oidc_resource_finance_as`、`oidc_stub_saas_op`）。同一コレクションを2アプリで共有しない。
- ドキュメント ID は key をそのまま使えない（`/` を含むため）。`encodeKey(key)` で `/` を `__` に置換し、さらに base64url 化する。復号は `list` の結果に含める `key` フィールドから行い、ドキュメント ID を逆変換しない。
- 保存形は `{ key: string; value: unknown; expireAt: Timestamp | null }`。`ttlSeconds` が与えられたら `expireAt` を設定し、Firestore の TTL ポリシーで削除させる。
- `get` は `expireAt` が過去のドキュメントを `null` として返す（TTL 削除には遅延があるため、読み取り側でも期限を見る）。
- `list(prefix)` は `where('key', '>=', prefix).where('key', '<', prefix + '\uf8ff')` の範囲クエリで実装し、期限切れを除外する。全件取得してアプリ側でフィルタする実装にしない。
- インターフェイスの型は生成物の `store.ts` から import せず、`packages/gcp/src/json-store-backend.d.ts` に同じ形を書いて構造的に一致させる。生成物への依存方向を作らない。
- `firestore-guard.ts`（DEV-05 の許可マトリクス）はこのタスクの範囲外で、データ層の領域が同じパッケージへ追加する。

**完了条件**
- [ ] `firestore-json-store.spec.ts::get put delete round trip` が Firestore エミュレータ上で緑（`STORE_MODE=emulator`）。
- [ ] `firestore-json-store.spec.ts::list returns only prefix matches` が、`transaction:` と `access-token:` の両方を投入したときに前者だけを返す。
- [ ] `firestore-json-store.spec.ts::expired entry reads as null` が、`expireAt` を過去にしたドキュメントで `null` を返す。
- [ ] `grep -rn "@google-cloud/firestore" apps/ packages/ --include=*.ts | grep -v "packages/gcp/src"` が0件である。

---

### T-PKG-26 単一 Dockerfile と Makefile を作る

**概要**
DEC-APP-02 は、リポジトリ直下の単一 multi-stage Dockerfile を `--build-arg APP=<name>` で切り替え、実行段を distroless にすると定めている。
DEC-IAC-18 はビルドと push を Terraform 管理外の Makefile で行うと定めている。
この2つのファイルを用意し、`make images` で全アプリのイメージが Artifact Registry へ push される状態にする。

**対象要件** なし（DEC-APP-02、DEC-IAC-18 に基づく基盤タスク）
**前提タスク** T-PKG-01, T-PKG-23
**成果物**
- `Dockerfile`
- `.dockerignore`
- `Makefile`
- `scripts/build-images.sh`

**実装方針**
- Dockerfile の段は3つ。`deps`（`node:22-slim` で `pnpm install --frozen-lockfile`）、`build`（`pnpm build` で全 workspace を tsc ビルドし、`pnpm deploy --filter <APP> --prod` で対象アプリの実行時ツリーを切り出す）、`runtime`（`gcr.io/distroless/nodejs22-debian12` に切り出したツリーだけを COPY）。
- `ARG APP` を `build` 段と `runtime` 段の両方で宣言する。`CMD ["dist/server.js"]` を固定し、アプリごとにエントリ名を変えない。
- `.dockerignore` に `.git`、`node_modules`、`infra`、`e2e`、`docs`、`**/test` を列挙する。
- Makefile は `.PHONY` を明記し、次のターゲットを定義する。`install`、`typecheck`、`lint`、`test`、`test-integration`、`images`、`image-<app>`、`ci`。infra 系の `bootstrap` / `shared-apply` / `demo-apply` / `seed` / `demo-destroy` は infra 領域が同じ Makefile に追記するため、`# --- infra targets (T-INFRA) ---` の見出し行だけを置く。
- `IMAGE_TAG` は既定で `git rev-parse --short HEAD` の結果とし、`make images IMAGE_TAG=xxx` で上書きできるようにする。`latest` タグを付けない（DEC-IAC-18 の image_tag 変数へ渡すため）。
- `build-images.sh` はアプリ名の配列をループして `docker build --build-arg APP=$app -t $REGISTRY/$app:$IMAGE_TAG .` と `docker push` を実行する。1つでも失敗したら `set -euo pipefail` で即座に落ちる。
- Cloud Build を使わない。`cloudbuild.yaml` を作らない。

**完了条件**
- [ ] `docker build --build-arg APP=human-idp -t xaa/human-idp:test .` が成功する。
- [ ] ビルドされたイメージの `docker run --rm --entrypoint /nodejs/bin/node xaa/human-idp:test -e "console.log(1)"` が `1` を出力する。
- [ ] `make images IMAGE_TAG=dryrun REGISTRY=localhost/xaa DRY_RUN=1` が全アプリ分の build コマンドを標準出力へ列挙して終了コード 0 を返す。
- [ ] `grep -rn "latest" Makefile scripts/build-images.sh` がタグ指定として0件である。

---

### T-PKG-27 CI の typecheck / lint / unit / integration ジョブを作る

**概要**
4つの基本ジョブを GitHub Actions に定義する。
lint ジョブでは REQ-09-038 の `no-restricted-imports` と、REQ-01-016 の「汎用 verifyJwt をルートから呼ばない」を静的検査として実行する。
integration は Firestore エミュレータを起動して同一プロセスのハーネスで走らせる。

**対象要件** REQ-09-038, REQ-01-016
**前提タスク** T-PKG-02, T-PKG-23, T-PKG-25
**成果物**
- `.github/workflows/ci.yml`
- `eslint.config.js`（restricted imports の設定を追加）
- `scripts/check-verifier-usage.mjs`
- `apps/agent-op/test/lint/no-heavy-logic.spec.ts`（fixture 用の雛形）

**実装方針**
- ジョブは `typecheck`、`lint`、`unit`、`integration`、`check-deps` の5つ。`unit` と `integration` は別ジョブにし、`unit` が落ちたら `integration` を実行しない（`needs`）。
- Node は `actions/setup-node` で 22 を指定し、pnpm は `pnpm/action-setup` でルート package.json の `packageManager` から解決する。
- `lint` ジョブは `pnpm lint` に加えて `node scripts/check-deps.mjs`、`node scripts/check-identifier-aliases.mjs`、`node scripts/check-create-app.mjs`、`node scripts/check-verifier-usage.mjs` を実行する。
- `eslint.config.js` に `no-restricted-imports` を2組で書く。(1) `apps/agent-op/**` と `apps/agent-runtime/**` から `@platform/security/rules`、`@platform/security/correlation`、`@platform/security/scoring`、`@platform/security/ai` の import を禁止（REQ-09-038）、(2) 全 `apps/**` から `@xaa/crypto/dist/verifiers-internal` を禁止。
- `check-verifier-usage.mjs` は `apps/*/src/routes/**` と `apps/*/src/middleware/**` を走査し、`verifyJwtInternal` と `decodeJwsUnverified` の呼び出しが無いことを検査する（`decodeJwsUnverified` はログ用モジュールでのみ許可し、許可パスをスクリプト内の配列に明示する）。
- `integration` ジョブは `gcr.io/google.com/cloudsdktool/google-cloud-cli` のエミュレータではなく、`firebase-tools` を使わずに `gcloud emulators firestore start` をサービスコンテナとして起動する。起動できない場合はジョブを失敗させ、スキップしない。
- 環境変数は `SIGNER_MODE=local`、`VERTEX_MODE=fake`、`PUBSUB_MODE=inproc`、`STORE_MODE=emulator`、`NODE_ENV=test` を integration ジョブに設定する。
- キャッシュは pnpm store のみ。ビルド成果物をキャッシュしない。

**完了条件**
- [ ] `.github/workflows/ci.yml` の5ジョブが Pull Request で起動し、すべて成功する。
- [ ] `apps/agent-op/src/routes/` に `import { rules } from '@platform/security/rules'` を含む fixture を置くと `pnpm lint` が終了コード 1 で失敗する。
- [ ] `node scripts/check-verifier-usage.mjs` が、ルートに `verifyJwtInternal(` を書いた fixture で終了コード 1 を返す。
- [ ] `integration` ジョブのログに Firestore エミュレータの起動行が出て、`pnpm test:integration` が実行される。

---

### T-PKG-28 check:oidc-patches ジョブを作る

**概要**
DEC-APP-04 は、生成物を `apps/<app>/src/oidc/` にコミットし、手編集を `// XAA-PATCH:<REQ-ID> begin` と `end` で囲み、無改変版を `generated-baseline/<app>/` に置くと定めている。
固定バージョンの CLI で再生成し、マーカー外の差分を検出するジョブを作る。
これが無いとライブラリ更新時の追従漏れに気付けない。

**対象要件** なし（DEC-APP-04、DEV-08 に基づく基盤タスク）
**前提タスク** T-PKG-27
**成果物**
- `scripts/check-oidc-patches.mjs`
- `scripts/regenerate-oidc.sh`
- `.github/workflows/ci.yml`（`check-oidc-patches` ジョブを追加）

**実装方針**
- `regenerate-oidc.sh` は `maronn-oidc generate hono` を4アプリ分（human-idp、resource-docs-as、resource-finance-as、stub-saas-op）実行し、出力を `generated-baseline/<app>/` へ書く。CLI のバージョンは `package.json` の厳密指定を使い、スクリプト内にバージョンを書かない。
- Agent OP は生成物をデプロイ経路に載せないため、`generated-baseline/agent-op-reference/` は生成するが `apps/agent-op/src/oidc/` との比較対象にしない（DEC-ID-01、DEV-08）。
- `check-oidc-patches.mjs` は各アプリについて次を行う。(1) `apps/<app>/src/oidc/` の全ファイルを読む、(2) `// XAA-PATCH:<REQ-ID> begin` から `// XAA-PATCH:<REQ-ID> end` までの範囲を除去した「マーカー外の内容」を作る、(3) `generated-baseline/<app>/` の対応ファイルと行単位で比較する、(4) 差分があればファイル名と行番号を出して終了コード 1。
- マーカーの `<REQ-ID>` が `REQ-\d{2}-\d{3}` の形式に一致しないものはエラーにする。理由なしの手編集を許さない。
- `begin` と `end` の対応が取れていない、入れ子になっている場合もエラーにする。
- 生成物側にのみ存在するファイルの削除も差分として検出する。ファイルの存在集合を比較する。
- CI ジョブは `check-oidc-patches` として `lint` と並列に置く。

**完了条件**
- [ ] `node scripts/check-oidc-patches.mjs` が現状のリポジトリで終了コード 0 を返す。
- [ ] マーカー外の1行を書き換えると終了コード 1 になり、ファイル名と行番号が標準エラーに出る。
- [ ] `// XAA-PATCH:FIXME begin` を書くと形式違反として終了コード 1 になる。
- [ ] `begin` だけ書いて `end` を書かないと終了コード 1 になる。

---

### T-PKG-29 infra の静的検査スクリプトを CI に組み込む

**概要**
DEC-IAC-04、DEC-IAC-08、DEC-IAC-25、DEV-13 は、Terraform と実装コードに対する4つの禁止事項を検査で固定すると定めている。
スクリプトの中身は infra とアプリの各領域が書くが、実行の枠組みと失敗時の扱いをこの領域で用意する。
`terraform` バイナリを必要としない grep ベースの検査だけをこのジョブに置く。

**対象要件** なし（DEC-IAC-04、DEC-IAC-08、DEC-IAC-25、DEV-13 に基づく基盤タスク）
**前提タスク** T-PKG-27
**成果物**
- `infra/tests/no-kms-key-version.sh`
- `infra/tests/runtime-mutation-scope.sh`
- `infra/tests/no-firestore-sdk-in-frontend.sh`
- `infra/tests/run-static-checks.sh`
- `.github/workflows/ci.yml`（`infra-static-checks` ジョブを追加）

**実装方針**
- 4スクリプトすべての先頭に `set -euo pipefail` を置き、検査対象が0件だったときも失敗させる（対象ディレクトリの消失を成功と誤認しないため）。
- `no-kms-key-version.sh`：`infra/**/*.tf` を `google_kms_crypto_key_version` で grep し、1件でもあれば終了コード 1（DEC-IAC-04）。
- `runtime-mutation-scope.sh`：`apps/provisioner/src/` と `apps/lifecycle-manager/src/` を対象に、GCP の作成と削除と更新の呼び出し（`@google-cloud/run` の `createService` / `deleteService` / `updateService` / `createJob` / `deleteJob`、`@google-cloud/kms` の `createCryptoKey` / `destroyCryptoKeyVersion`、`iam.googleapis.com` の Service Account 作成と削除）が、`assertRuntimeName` を同一関数内で呼ぶ経路にだけ現れることを検査する（DEC-IAC-08）。加えて、Terraform 管理のサービス名（`human-idp` / `shared-agent-op` / `automation-app` / `authorization` / `provisioner` / `lifecycle` / `security-detection` / `resource-docs-as` / `resource-docs-api` / `resource-finance-as` / `resource-finance-api` / `agent-op-callback`）が文字列リテラルとしてこれらの呼び出しの引数に現れたら終了コード 1 にする。`createKeyRing` はどこにも現れてはならない。
- `no-firestore-sdk-in-frontend.sh`：`apps/automation-app/src/client/` と esbuild の出力先 `apps/automation-app/public/` を `firebase`、`@firebase`、`firestore` で grep し、1件でもあれば終了コード 1（DEV-13）。
- `forbidden-roles.sh` は Terraform の plan JSON を読むため、この grep ジョブではなく infra 領域の apply 後検査に置く。このジョブからは呼ばない。
- `run-static-checks.sh` は3スクリプトを順に実行し、1つでも失敗したら残りも実行してから非ゼロで終わる（どれが落ちたかを1回のログで分かるようにする）。
- CI ジョブは `infra-static-checks` として `ubuntu-latest` で走らせる。Node も Terraform もインストールしない。

**完了条件**
- [ ] `bash infra/tests/run-static-checks.sh` が現状のリポジトリで終了コード 0 を返す。
- [ ] `infra/envs/demo/` に `resource "google_kms_crypto_key_version" "x" {}` を書いたファイルを置くと終了コード 1 になる。
- [ ] `apps/provisioner/src/` に `assertRuntimeName` を呼ばない `client.createService(` を含むファイルを置くと終了コード 1 になる。
- [ ] `apps/lifecycle-manager/src/` に `client.deleteService({ name: "human-idp" })` を含むファイルを置くと終了コード 1 になる。
- [ ] `apps/provisioner/src/` の対象ディレクトリを削除すると、検査対象0件として終了コード 1 になる。

---

### T-PKG-30 docs:deviations ジョブを作る

**概要**
specs 7章は `docs/deviations.md` を4列表に固定し、4列すべてが埋まっていない行があれば CI を失敗させると定めている。
代替実装のパスが実在すること、テスト名が実在するテストと一致することを機械判定する。
逸脱の記述が実装から乖離した状態を防ぐ。

**対象要件** なし（specs 7章の確定内容に対応）
**前提タスク** T-PKG-27
**成果物**
- `scripts/check-deviations.mjs`
- `docs/deviations.md`（15行の表の骨格を作成）
- `.github/workflows/ci.yml`（`docs-deviations` ジョブを追加）

**実装方針**
- `docs/deviations.md` の表は5列（逸脱ID、逸脱した RULE / docs 節、代替実装、固定するテスト、相互運用を期待しない範囲）で、判定対象は3列目から5列目とする。specs 7章の DEV-01 から DEV-15 の内容をそのまま転記する。DEV-07 は取り下げ行として扱い、4列の非空検査から除外する。
- `check-deviations.mjs` は次を検査する。(1) 表のヘッダが期待どおりであること、(2) 逸脱ID が `DEV-\d{2}` で連番かつ重複が無いこと、(3) 3列目のバッククォート内のパスがすべて実在すること（ディレクトリ指定は末尾 `/` を許す）、(4) 4列目の `パス::テスト名` のパスが実在し、そのファイル内にテスト名の文字列が含まれること、(5) 5列目が空でないこと。
- 4列目は `/` 区切りで複数のテスト名を並べる形式を許す（`dpop.spec.ts::rejects htu mismatch / iat out of window / ...`）。分割してそれぞれを grep する。
- テスト名の照合は `it('` や `test('` の直後の文字列に対する部分一致とする。完全一致にすると `it.each` の記述で落ちるため。
- 失敗時は「どの DEV 行のどの列が、どのパスまたはどのテスト名で失敗したか」を1行ずつ出す。まとめて1行で報告しない。
- ジョブ名は `docs-deviations`。`pnpm docs:deviations` からも同じスクリプトを呼べるようにする。

**完了条件**
- [ ] `pnpm docs:deviations` が `docs/deviations.md` の15行すべてで終了コード 0 を返す。
- [ ] 任意の行の4列目のテスト名を1文字変えると終了コード 1 になり、その DEV 番号と列が標準エラーに出る。
- [ ] 任意の行の3列目を存在しないパスに変えると終了コード 1 になる。
- [ ] DEV-01 の行の4列目が `packages/xaa-crypto/test/dpop.spec.ts::rejects htu mismatch / iat out of window / replayed jti / ath mismatch / Bearer scheme` で、5つすべてが T-PKG-10 と T-PKG-12 のテストとして実在する。

---

## このファイルで扱わない要件

`/home/user/.wf/reqs-op.md` の47件のうち、共有パッケージとテスト基盤で扱うのは18件。
残る29件は Agent OP、Lifecycle、Security、Infra の各領域で扱う。
この領域は「暗号とトークンの部品を提供する」までを担当し、部品を並べて判定する処理は提供先の領域が持つ。

| 要件ID | 扱う領域 | 扱うタスク |
|---|---|---|
| REQ-01-004 | Agent OP | T-OP（act.sub と sub の同一値拒否） |
| REQ-01-028 | Agent OP | T-OP（subject_token 取得と Revoke の経路） |
| REQ-05-026 | Agent OP | T-OP（パス構成と不要ルート削除） |
| REQ-05-035 | Agent OP | T-OP（4分類のリポジトリ実装。スキーマ定義のみ T-PKG-20） |
| REQ-05-036 | Agent OP と Infra | T-OP と T-INFRA（SA ロールの許可リスト） |
| REQ-05-037 | Agent OP | T-OP（静的注入と動的問い合わせの排除） |
| REQ-05-041 | Agent OP | T-OP（client_assertion_jwt ミドルウェア。DEV-02） |
| REQ-05-045 | Agent OP | T-OP（idp_connections レコード） |
| REQ-05-047 | Agent OP と Provisioner | T-OP と T-PROV（offline_access の中断と再開） |
| REQ-05-048 | Agent OP | T-OP（/xaa/callback の応答内容） |
| REQ-05-051 | Agent OP | T-OP（/xaa/subject-token） |
| REQ-05-061 | Agent OP | T-OP-06（専用署名鍵の kid と共有 JWKS 掲載） |
| REQ-05-071 | Agent OP | T-OP（RULE-49 の委譲照合ステップ） |
| REQ-05-072 | Agent OP | T-OP-10（expires_at と status 判定） |
| REQ-05-073 | Agent OP | T-OP（静的 XAA 設定との照合） |
| REQ-05-076 | Agent OP | T-OP（ID-JAG クレーム構築） |
| REQ-05-078 | Agent OP | T-OP-20（exp の cap 計算） |
| REQ-07-016 | Agent OP | T-OP-10（Identity 層の期限強制） |
| REQ-07-017 | Agent OP | T-OP-20（Authorization 層の期限強制） |
| REQ-08-015 | Infra と Agent OP | T-INFRA と T-OP（MODE=token / callback の2サービス分割） |
| REQ-08-017 | Agent OP と Human IdP | T-OP と T-IDP（JWKS の read-modify-write 書き込み） |
| REQ-09-008 | Agent OP | T-OP（Token Exchange の14項目ログ） |
| REQ-09-009 | Agent OP | T-OP（IdP Connection のログ） |
| REQ-09-021 | Agent OP と Security | T-OP と T-SEC（delegation_mismatch の検知） |
| REQ-09-022 | Agent OP | T-OP（ID-JAG 発行台帳） |
| REQ-09-024 | Agent OP | T-OP（xaa_config_out_of_range の検知） |
| REQ-09-025 | Agent OP | T-OP（Refresh Token 再利用検知） |
| REQ-09-048 | Agent OP | T-OP（QUARANTINED での発行停止） |
| REQ-11-018 | Agent OP と Runtime と Resource AS | T-OP、T-RUN、T-RES（PROTOCOL_VIOLATION の発行箇所限定） |
