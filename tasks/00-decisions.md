# 00. 設計判断

本ファイルは、[docs](../docs/README.md) の設計と、依頼時に与えられた制約の両方を満たすために確定させた判断をまとめる。
`tasks/` 配下の各タスクは、ここに書いた判断を前提にしている。
判断を変える場合は、変更理由と、影響する RULE と、増減する逸脱行を併せて起票する。

判断の根拠は本ファイルに書き、タスク側では繰り返さない。
docs のルールから外れる判断には、外れたルール番号を「逸脱」として明記した。
逸脱の一覧と代替統制は [docs/deviations.md](../docs/deviations.md)（T-DOCS-02 で作成）が正本になる。


## スコープと優先順位
- DEC-SCOPE-01 優先順位は 制約1(IaCで管理できる) > 制約2(単一プロジェクト) > 制約5(低コスト/一時利用) > docs要件の完全達成。
- DEC-SCOPE-02 P0 の最初に spike(前提4点の実測)を置く。(a) VPCなしで ingress=INTERNAL_ONLY が Cloud Run 間呼び出し / Cloud Scheduler OIDC / Pub/Sub push を通すか、(b) Cloud Run URL が `https://<service>-<project_number>.<region>.run.app` の決定的形式か、(c) allUsers invoker が組織ポリシーで禁止されていないか、(d) google_iam_deny_policy がスタンドアロンプロジェクトで使えるか。使い捨ての infra/spike/main.tf で実測し、結果を infra/spike/RESULT.md に残す。これが終わるまで P1 以降に着手しない。
- DEC-SCOPE-03 Capability / scope / Tool ID の命名は1組に確定し、packages/xaa-contracts の1ファイルに定数として置く。別名を作らない。
- DEC-SCOPE-04 Google Bridge と外部SaaS連携は Terraform 変数 enable_google_bridge(既定 false) / saas_connector_mode(stub|google、既定 stub)で切る。既定 apply では Bridge 関連サービスを作らない。
- DEC-SCOPE-05 docs にある機能はすべてタスクとして起票する。検証の主眼(XAA / ID-JAG / DPoP / Isolation)から遠いものはフェーズを後ろに置くが、バックログへ落として消さない。

## Identity と認証プロトコル
- DEC-ID-01 OP は4系統。human-idp / resource-docs-as / resource-finance-as / stub-saas-op は `maronn-oidc generate hono` の生成物をコミットして使う。agent-op だけは生成物をデプロイ経路に載せず、`@maronn-openid-connect/experimental/id-jag` の export 済みステップ関数を直接組み替えた素の Hono アプリにする。生成物は generated-baseline/agent-op-reference/ に参照用として置く。
  - 注記（実装時の変更）: stub-saas-op は生成物を使わず、約140行の手書き Hono アプリ（apps/stub-saas-op/src/index.ts）にした。テスト専用のフィクスチャで本 platform が運用する OP ではないため、生成物とベースライン（generated-baseline/stub-saas-op/）を持たず、scripts/check-oidc-patches.mjs の比較対象からも外す（T-BRIDGE-19）。生成物を使う OP は human-idp / resource-docs-as / resource-finance-as の3系統になる。
- DEC-ID-02 core / experimental / cli へ機能追加も fork もパッチも行わない。バージョンは exact 指定でピン留めし、破壊的変更は packages/xaa-contracts の契約テストで検知する。
- DEC-ID-03 Human IdP と Agent OP に同一の ISSUER 文字列を与える。Human IdP だけが /authorize /token /userinfo /logout /.well-known/openid-configuration を提供し、Agent OP は /xaa/token /xaa/callback /xaa/subject-token /internal/* のみを提供する。Agent OP に discovery ルートを持たせない。
- DEC-ID-04 issuer_profile 変数を direct(既定) / loadbalancer の2値にする。direct では External Application Load Balancer / Cloud Armor / 静的IP / マネージド証明書を1つも作らず、issuer = human-idp の Cloud Run URL、jwks_uri = JWKS バケットの公開オブジェクト URL、/xaa/token は agent-op の別ホストにする。ID-JAG の `iss` が Human IdP の issuer 識別子である点は両プロファイルで保つ。
- DEC-ID-05 ID-JAG の `audience` は Resource AS の issuer(https URL)に固定する。URN(urn:xaa:...)にしない。redeem-id-jag.ts の verifyIdJagAssertion が `aud === options.issuer` をバイト一致で要求し、core の validateIssuer が https を強制するため、URN では受領側が成立しない。URL 変動対策は locals で `https://<service>-<project_number>.<region>.run.app` を決定論的に組み立てることで解く。`resource` は RFC 8707 の絶対 URI(Resource API の URL)とする。
- DEC-ID-06 Agent OP の /xaa/token は processIdJagIssuanceRequest を使わず、ステップ関数を次の順で並べる。authorizeIdJagIssuanceClient → parseIdJagIssuanceParams → resolveIdJagSubject → resolveIdJagActorToken → 【RULE-49 の委譲照合】 → 【Registration の status / expires_at 判定】 → validateIdJagAudience → validateIdJagScope → 【resource 照合】 → buildIdJagClaims → 【cnf 付与と exp cap】 → signIdJag → buildIdJagIssuanceResponse。
- DEC-ID-07 RULE-49(委譲関係の照合)は actorTokenResolver の中では実装できない(resolver 入力に subject が無い)。上記の並びで subject と actor が揃った位置に自前の照合ステップを置く。`actor_token` の `sub` から引いた Agent Registration の `human_subject` が `subject_token` の `sub` と一致しなければ `invalid_grant` を返す。
- DEC-ID-08 ID-JAG への `cnf.jkt` 付与は buildIdJagClaims の戻り値をスプレッドして `{...claims, cnf:{jkt}}` を作り、署名関数へ渡すことで行う。署名関数の引数型を Record<string, unknown> にして cast を不要にする。cnf を持たない ID-JAG を発行する分岐を実装しない。
- DEC-ID-09 ID-JAG の `exp` は min(iat + idJagLifetimeSeconds, Agent Registration の expires_at) とし、現在時刻以下になる場合は発行せず `invalid_grant` を返す。
- DEC-ID-10 actor_token は本システム独自プロファイル。`actor_token_type` を `urn:ietf:params:oauth:token-type:jwt` に固定し、JOSE ヘッダの `typ` は `agent-assertion+jwt` を必須にする。`act.sub` は `urn:xaa:agent:<agent_id>` の名前空間へ正規化する。actorTokenResolver の先頭で型が違えば null を返すガードを置く。
- DEC-ID-11 Agent Client Credential の Layer 2 認証は、ライブラリの client-auth(client_secret_basic/post/none のみ)を使わず、Agent OP の自前ミドルウェア `client_assertion_jwt` で行う。`typ=agent-client-auth+jwt` を必須にし、Agent Registration の `jwk_thumbprint` に対応する鍵で署名検証し、`jti` の再利用を拒否する。OIDC の private_key_jwt とは別物として discovery に広告しない。
- DEC-ID-12 DPoP(RFC 9449)は packages/xaa-crypto として自前実装する。機能は ES256 鍵ペア生成 / Proof 生成(htm/htu/iat/jti/ath) / Proof 検証 / RFC 7638 Thumbprint / jti 重複排除の5つ。**Access Token と併用する Proof には `ath`(SHA-256 の base64url)を必須にする**。検証順序は 署名 → typ → htm → htu → iat 窓 → jti 重複 → ath 一致 に固定する。
- DEC-ID-13 DPoP の適用は3経路。(1) Agent Runtime → Agent OP /xaa/token、(2) Agent Runtime → Resource AS および Resource API、(3) Automation App → Control Plane 3アプリ。Bridge から外部 SaaS への外向きは Bearer のままとする。
- DEC-ID-14 Resource AS のクライアント認証を client_secret から `cnf.jkt` の PoP へ置き換える。verifyIdJagAssertion の戻り値に cnf は載らないため、(1) parseIdJagRedemptionParams → (2) verifyIdJagAssertion → (3) 検証済み assertion の payload を再デコードして cnf を取り出す → (4) cnf 不在または jkt が文字列でなければ `invalid_grant` → (5) DPoP Proof の鍵 thumbprint と一致検証、の順で fail-closed に実装する。
- DEC-ID-15 受領側の grant_type は `urn:ietf:params:oauth:grant-type:jwt-bearer`。docs の `jwt-dpop` は IANA にもドラフトにもライブラリにも存在しないタイポとして docs を訂正する(逸脱ではない)。
- DEC-ID-16 KMS の asymmetricSign を使うのは ID-JAG 署名のみ。alg は ES256(EC_SIGN_P256_SHA256)に統一し、DER 署名を JOSE の raw R||S へ変換する処理を packages/xaa-crypto に置く。署名関数は `typ` を引数で受け取らず内部で `oauth-id-jag+jwt` に固定する。
- DEC-ID-17 Human IdP と Resource AS 2種の署名鍵は KMS に置けない(core の SigningKeyProvider が CryptoKey を要求するため)。ローカル生成した JWK を KMS の ENCRYPT_DECRYPT 鍵で封筒暗号して GCS の非公開バケットへ置き、起動時に KMS decrypt → WebCrypto import して SigningKeyProvider へ渡す。**初回生成は手動スクリプトにせず、アプリ起動時の自己ブートストラップ(存在しなければ生成して書き込む、冪等で並行安全)にする**。terraform apply だけで系が立ち上がる状態を保つ。
- DEC-ID-18 共有 issuer と共有 JWKS の下では ID Token(typ=JWT) / Access Token(typ=at+jwt) / ID-JAG(typ=oauth-id-jag+jwt) が同じ iss と JWKS に並ぶ。取り違えを防ぐため、**すべての検証経路で署名検証の直後に typ を検査する**。Control Plane と Resource API の保護ミドルウェアは `at+jwt` 以外を 401 にする。
- DEC-ID-19 subject_token の供給は Agent OP の `/xaa/subject-token`。自前で ID Token を生成せず、idp_connections に保存した当該 Agent の Refresh Token を KMS で復号し、Human IdP の /token へ `grant_type=refresh_token`(client_id=agent-platform)を実行して、その応答の `id_token` だけを返す。access_token と refresh_token は落とす。`idJagConfig.allowRefreshTokenSubjects` は false に固定し refreshTokenResolver を注入しない。
- DEC-ID-20 subject_token 検証に使う JWKS は kid 接頭辞 `idp-*`(Human IdP の SSO 鍵)に限定する。
- DEC-ID-21 Resource AS の生成物から ID-JAG 発行分岐を削除し、discovery から `identity_chaining_requested_token_types_supported` の行も削除する(`authorization_grant_profiles_supported` は残す)。発行できるのは Agent OP だけにする。
- DEC-ID-22 Agent ごとのクライアント登録を作らない。client_id は `agent-platform` 1つ。Agent 個体の識別は `cnf.jkt` / `act` / 監査ログの3つ。

## インフラと IaC
- DEC-IAC-01 Terraform を bootstrap / shared / demo の3 state に分ける。GCS backend(versioning 有効、uniform BLA)。apply→destroy を繰り返す対象は demo state だけにする。
- DEC-IAC-02 versions.tf で terraform の required_version と provider バージョンをピン留めし、.terraform.lock.hcl をコミットする。3 state すべてに置く。
- DEC-IAC-03 shared state に KMS Key Ring / CryptoKey、Artifact Registry、BigQuery 監査 dataset、Log Sink、Secret を置く。KMS 鍵は削除できないため destroy 対象から外す。demo state から terraform_remote_state で参照する。
- DEC-IAC-04 **Terraform に google_kms_crypto_key_version リソースを書かない**。初期バージョンは CryptoKey 作成時に GCP が暗黙生成するものだけを使う。Lifecycle の Cleanup が版を追加/無効化しても state と食い違わないようにする。`*.tf に google_kms_crypto_key_version が出現しない`ことを CI で検査する。
- DEC-IAC-05 Cloud Run URL を locals で `https://<service>-<project_number>.<region>.run.app` と決定論的に組み立て、plan 時に確定させる。service.uri からの参照に依存しない。
- DEC-IAC-06 seed の宛先解決は「Terraform が解決済みの値を成果物として書き出す」形にする。`google_storage_bucket_object "platform_endpoints"` に issuer / jwks_url / xaa_token_url / 各 Resource の URL を jsonencode して非公開バケットへ置き、seed ジョブはそれを読む。Job の中で terraform コマンドを実行しない。
- DEC-IAC-07 FULL_ISOLATION の Dedicated OP 一式は Terraform の管理対象から外し、Agent Provisioner が Provisioning 時に GCP API で作り、Lifecycle Manager が Cleanup で消す。docs 05 §5、07 §3.3、08 §5 の記述どおりであり、RULE-32 と RULE-33 に逸脱は生じない。実行時に作るのは、`dedicated-op-<short>`（Cloud Run Service）、`sa-op-<short>`、`idjag-<short>`（KMS ASYMMETRIC_SIGN 鍵）、`idpconn-<short>`（KMS ENCRYPT_DECRYPT 鍵）、`agent-runtime-<short>`（Cloud Run Job）、`sa-agent-<short>`、およびそれらを結ぶ IAM Binding の7種。`<short>` は `agent_id` の乱数部の末尾12文字とする。Terraform が管理するのは、これらの入れ物である KMS Key Ring と、Provisioner と Lifecycle に与える作成権限までとする。
  - IaC で管理しない理由は、この一式が Agent と同じ最大24時間で必ず消えるためである。再現性を IaC が保証する価値が無い。固定数を事前作成する方式にすると、同時実行数が固定されるうえ、使われていない待機中のリソースが常時ぶら下がる。
  - この一式は Terraform の state に載らないため、`terraform destroy` では消えない。DEC-IAC-25 の掃除で回収する。
- DEC-IAC-08 Provisioner と Lifecycle の SA には、Dedicated OP 一式を作り消すために必要な権限だけを、リソース種別と名前の接頭辞で絞って与える。`sa-provisioner` には Cloud Run Service の作成と、Service Account の作成と、`idjag-signing` と `idp-connection-encryption` の各 Key Ring に対する `roles/cloudkms.admin`、および作成した SA に対する `roles/iam.serviceAccountUser` を与える。`sa-lifecycle` には Cloud Run Service と Service Account の削除と、KMS 鍵バージョンの無効化と破棄予約を与える。
  - Terraform が管理するリソースを実行時に変更してはならない。この境界は名前で分ける。実行時に触れてよいのは `dedicated-op-` / `sa-op-` / `sa-agent-` / `idjag-` / `idpconn-` / `agent-runtime-` で始まり、かつラベル `xaa-managed=runtime` を持つものに限る。それ以外の名前に対する変更呼び出しをコードに書かない。
  - 両アプリはこの権限により Project 内で最も強い SA になる。docs 08 §5 の記述どおり、内部公開に限定し、Provisioner は DPoP 束縛の Human Access Token を伴う要求だけを受け付ける。
- DEC-IAC-09 データストアは **Firestore(Native mode)1本**にする。Cloud SQL を既定構成では使わない。原子性が要る FULL_ISOLATION の同時実行数の確保と Provisioning Transaction の作成は Firestore の runTransaction で行う。生成 OP のストアは templates.ts の JsonStoreBackend を Firestore バックエンドで実装して差し替える。docs 08 §7.1 の論理DB分離は「アプリ側のパスガード(許可マトリクス1ファイル)」で代替する。
- DEC-IAC-10 Firestore Security Rules を作らない。ブラウザから Firestore へ直接アクセスさせない統制は「フロントに Firestore SDK を含めない / Firebase Auth を導入しない / REST API のみ」で担保し、CI で SDK 混入を検査する。
- DEC-IAC-11 単一プロジェクト内の監査ログ分離は3層。(1) BigQuery dataset security_audit を専用 SA と `google_bigquery_dataset_iam_binding`(authoritative)で固定、(2) Log Sink の writer identity にだけ書き込み権限、(3) 変数 enable_deny_policy(既定 false、spike で使用可と分かれば true)で IAM Deny Policy。**同一プロジェクトの Owner は両方へ届くため2プロジェクト構成より保護が弱いことを infra/README に明記する**。
- DEC-IAC-12 KMS は Key Ring を用途で分ける。sso-signing / idjag-signing / resource-as-signing / connector-encryption / idp-connection-encryption。署名鍵は EC_SIGN_P256_SHA256、暗号鍵は ENCRYPT_DECRYPT。IAM は CryptoKey 単位で付与する。
- DEC-IAC-13 共有 JWKS は GCS バケット。各アプリは自分専用のオブジェクト `keys/<prefix>-<kid>.json` だけを書き(IAM 条件で prefix 限定)、`jwks.json` は jwks-publish Job が keys/ をマージして書き出す。バケットは uniform BLA、allUsers に objectViewer。
- DEC-IAC-14 公開(allUsers invoker)するのは automation-app / human-idp / agent-op-callback の3つ。enable_google_bridge=true のとき google-bridge-callback と stub-saas-op が加わる。それ以外への到達可否は run.invoker だけで決める。
  - 改訂(2026-09-05、DEC-SCOPE-02 の spike (a) を実測した結果)。当初は「公開する3つ以外は ingress=INTERNAL_ONLY」としていたが、VPC を持たない Cloud Run Service 間の呼び出しはインターネットを経由するため INTERNAL_ONLY には内部として届かず、IAM を読む手前で 404 になる（infra/spike/RESULT.md）。Cloud Scheduler と Pub/Sub push は届く。
  - よって **ingress を開ける集合と allUsers の集合を分ける**。ingress=ALL は「公開集合 + 他の Cloud Run Service / Job から呼ばれる集合」とし、後者は locals.invoker_edge_pairs から導出する(locals.run_called_services)。allUsers は公開集合のまま動かさない。VPC / Serverless VPC Access / INTERNAL_LOAD_BALANCER へは寄らない(DEC-SCOPE-01 の制約5)。
  - 失うのは多層防御の外側1枚だけである。未認証の要求は「存在しないホスト」として落ちる代わりに玄関で 403 になる。誰が呼べるかは run.invoker が決め続け、Provisioner が実行時に作る Dedicated OP も同じ扱いにする。
- DEC-IAC-15 run.invoker の付与を locals.invoker_edges マップ1か所に集約し for_each で生成する。apply 後に reachability テストで全エッジの疎通を確認する。
- DEC-IAC-16 Agent の生存時間は変数 agent_max_lifetime_seconds(既定 86400、検証プロファイル 3600)1つから、Job の task_timeout / Registration の expires_at 上限 / IdP Connection と Agent Binding の expires_at / ID-JAG の exp cap / Lifecycle tick の判定窓 をすべて導出する。
- DEC-IAC-17 Service Account はアプリごとに専用を作り、デフォルト SA を使わない。モジュールの variable validation で SA 未指定と compute default SA を apply エラーにする。
- DEC-IAC-18 コンテナイメージのビルドと push は Terraform 管理外の Makefile で行い、Terraform には image_tag を変数で渡す。Cloud Build を使わない。Artifact Registry は shared state。
- DEC-IAC-19 運用は make bootstrap → make shared-apply → make images → make demo-apply → make seed → デモ → make demo-destroy。demo-apply の後に reachability / forbidden-roles / invoker-matrix の3検査を自動実行する。
- DEC-IAC-20 loadbalancer プロファイル用の静的IPと証明書は shared 内の独立モジュールに置き、enable_lb_reservation(既定 false)で切る。未使用の予約IPが恒久的に課金されないようにする。

## アプリ実装
- DEC-APP-01 pnpm workspace の単一リポジトリ。トップレベルは apps/ packages/ infra/ e2e/ demo-scenarios/ docs/ tasks/ scripts/。
- DEC-APP-02 全 HTTP アプリを Node 22 + Hono + @hono/node-server、ESM のみ、ビルドは tsc。Agent Runtime だけ HTTP を listen しない素の Node エントリ。コンテナはリポジトリ直下の単一 multi-stage Dockerfile を `--build-arg APP=<name>` で切り替え、実行段は distroless。
- DEC-APP-03 初期の共有パッケージは2つに固定する。packages/xaa-crypto(DPoP / RFC 7638 / KMS ES256 署名と DER 変換 / base64url)と packages/xaa-contracts(typ / grant_type / scope / capability / tool_id の定数表、JSON Schema、httpClient ラッパ)。3つ目以降は「2つ目のアプリが import したくなった時点で切り出す」を規約にする。
- DEC-APP-04 生成物は apps/<app>/src/oidc/ にコミットし、手編集は `// XAA-PATCH:<REQ-ID> begin` / `end` で囲む。無改変版を generated-baseline/<app>/ に置き、CI が固定バージョンの CLI で再生成してマーカー外の差分を検出する。
- DEC-APP-05 スキーマは JSON Schema を単一の正とし、検証は Ajv(strict、additionalProperties:false)、TypeScript 型は json-schema-to-ts で導出する。
- DEC-APP-06 Automation App の UI は React SPA にせず、Hono JSX の SSR と esbuild で束ねた vanilla TypeScript にする。タイムラインの再生は固定8ノードの静的 SVG に CSS アニメーションを重ね、1ステップ 800ms 固定にする。
- DEC-APP-07 テストは3層。unit(vitest、GCP 依存なし)、integration(**全アプリを同一プロセス内の Hono として起動し `app.fetch(request)` を直接呼ぶ**。各アプリは `createApp(): Hono` を default export し、アプリ間呼び出しは packages/xaa-contracts の httpClient 経由で対向の app.fetch へ配線する)、e2e(Playwright。ブラウザが要るログイン / Consent / 承認 / タイムライン / デモのみ)。複数プロセスを起動するハーネスは作らない。
- DEC-APP-08 外部依存は許可リストで固定する。hono / @hono/node-server / ajv / ajv-formats / json-schema-to-ts / yaml / @google-cloud/{firestore,kms,pubsub,secret-manager,storage,bigquery,run,vertexai} と maronn の core / experimental / cli。JWT 検証、JWS 署名、DPoP、JWK Thumbprint、base64url は自前実装する。
- DEC-APP-09 差し替えはモード切替の環境変数で行う。SIGNER_MODE=local|kms、VERTEX_MODE=fake|live、PUBSUB_MODE=inproc|gcp、STORE_MODE=emulator|gcp。
- DEC-APP-10 Vertex AI のモデル名をアプリにハードコードせず、変数 vertex_model(既定 gemini-2.5-flash)で渡す。

## 監視とデモ
- DEC-SEC-01 Security Detection は「アプリが構造化ログを Cloud Logging へ出す → Log Sink で BigQuery へ入る → 保存済み SQL で検知する」を先に作る。SQL は delegation_mismatch / signing_key_misuse / cross_agent_access / dpop_replay の4本を必達とし、Rule / Correlation / Risk Score / Security AI の各段はその後のフェーズで積む。
- DEC-SEC-02 Protocol Validation の判定そのものは各アプリの同期処理として実装し、結果を構造化ログへ出す。Security Detection 側で再判定しない。
- DEC-DEMO-01 デモは実操作4種と台本4種に分け、実装経路を分離する。台本は `demo-scenarios/{scenario_id}.json` の4件のみを受け付け、API からイベント本文を渡させない。書き込み時にサーバ側で is_simulated / human_subject / task_id を上書きし、Pub/Sub も Security Detection も Agent Runtime も経由しない。

## 命名の確定
- Capability(8件)：calendar.event.read / calendar.event.write / mail.message.read / mail.message.send / document.read / document.write / finance.payment.read / finance.payment.approve
- Resource AS の scope：docs.read / docs.write / finance.tx.read / finance.tx.write / calendar.read / gmail.read / gmail.send
- Tool ID：internal.document.list|get|create|update / internal.finance.payment.list|get|approve / stub.calendar.events.list
- Capability ID の形式は `<resource>.<object>.<action>` または `<resource>.<action>`。ベンダー名と HTTP メソッド名を含めない。

## データストア（追補）
- DEC-IAC-21 Firestore は `(default)` ではなく名前付きデータベース `xaa` を作る。`location_id` は変数 `firestore_location`（既定は `region`）で明示し、`deletion_policy=DELETE` とする。全アプリのクライアントへ `databaseId` を環境変数で渡す。`(default)` はロケーションがプロジェクトの寿命に紐づくため、リージョンを変えた作り直しができない。
- DEC-IAC-22 Firestore のコレクションは `agents/{agent_id}`（配下に `state` / `instructions` / `manifest` / `meta`）、`idp_connections`、`consents`、`dpop_jti`、`assertion_jti`、`idjag_issuance`、`dedicated_resources`、`provisioning_transactions`、`catalog_*`、`documents`、`payments`、`users/{sub}/activity` とする。パス単位の権限分離は IAM で表現できない（`roles/datastore.user` はデータベース単位）ため、packages/xaa-contracts の Firestore パスガード1ファイルに「呼び出し元アプリ名 → 許可パス接頭辞」の許可マトリクスを定義し、全アクセスをこれ経由に限定する。参照範囲の照合は `withAgentOwnership(agentId, sub)` 1本に集約し、`agents/{id}/meta.human_subject` を先に読んで `sub` と照合し、不一致なら 404 を返してから `state` と `instructions` を読む。
- DEC-IAC-23 FULL_ISOLATION の同時実行数は変数 `max_full_isolation_agents`（既定 5）で上限を置く。Provisioner は `runTransaction` の中で「`ACTIVE` かつ `full_isolation` の Agent 数が上限未満であること」の確認と、`dedicated_resources/{agent_id}` の作成と、`provisioning_transactions/{id}` の作成を同一トランザクションで行う。上限に達している場合は 503 `full_isolation_capacity_reached` を返し、待ち行列を作らない。Policy Engine 側で FULL_ISOLATION を STANDARD へ自動降格しない。
  - 上限を置く理由はコストではなく GCP の制限である。Project あたりの Service Account 数の既定上限は100で、削除した Service Account は30日間その枠を占め続ける。上限が無いと、24時間ごとに使い捨てる運用で枠を使い切る。
  - `dedicated_resources/{agent_id}` は作成した GCP リソースの完全修飾名を記録する台帳とする。Cleanup と掃除はこの台帳だけを見て消す対象を決め、名前を組み立て直さない。作成の途中で失敗した場合も、作成済みのものが台帳に残るため回収できる。
- DEC-IAC-25 実行時に作った GCP リソースには必ずラベル `xaa-managed=runtime` と `xaa-agent-id=<agent_id>` を付ける。Lifecycle Manager の `/internal/tick` は、対応する Agent が存在しないか `expires_at` を過ぎているラベル付きリソースを掃除する。`make demo-destroy` は `terraform destroy` の前に `scripts/purge-runtime-resources.sh` を実行し、ラベル付きリソースを先に消す。KMS の CryptoKey は GCP の仕様で削除できないため、鍵バージョンの破棄予約までを行い、空の CryptoKey は Key Ring に残す。残った CryptoKey に課金は発生しない。
- DEC-IAC-24 `users/{sub}/activity` の保持期間は7日とし、`expire_at` に対する TTL を `google_firestore_field` で管理する。

## 監視とデモ（追補）
- DEC-SEC-03 Pub/Sub のトピックは `agent-activity-stream` / `security-logs` / `human-permission-changed` / `human-identity-disabled` の4つ。`agent-activity-stream` だけを automation-app への push subscription（OIDC）にし、残り3つは pull にする。push の宛先を ingress=INTERNAL のサービスにすると到達性が不確実になるため、宛先が公開サービスであるものだけを push にする。publisher はトピック単位の IAM でのみ付与し、プロジェクトレベルの `roles/pubsub.publisher` を誰にも付けない。
- DEC-SEC-04 `PROTOCOL_VIOLATION` の Activity Event を発行するのは Agent OP、Tool Executor、Native Resource AS の3箇所に限る。Human IdP と Bridge は Security ログだけを出す。人間向けの説明文を埋め込む責務を散らさないためである。
- DEC-SEC-05 ログの redaction は必須で実装する。フィールド名の deny list、JWT の形状判定、高エントロピー判定の3つで落とし、相関には fingerprint（SHA-256 の先頭16桁）を使う。
- DEC-SEC-06 `docs/deviations.md` は「逸脱ID / 逸脱した RULE 番号と docs 節 / 代替実装のファイルパス / それを固定するテストのファイルパス::テスト名」の4列表に固定する。4列すべてが埋まっていない行があれば CI ジョブ `docs:deviations` を失敗させる。パスの存在チェックとテスト名の grep で機械判定する。

## テスト方式
- DEC-TEST-01 テストは unit と integration と e2e の3層。XAA の回帰は integration に一本化し、複数プロセスを起動するハーネスを作らない。各アプリは `createApp(): Hono` を default export し、テストは `app.fetch(request)` を直接呼ぶ。アプリ間呼び出しは packages/xaa-contracts の `httpClient` ラッパ1つを経由させ、テストでは対向アプリの `app.fetch` へ配線する。
- DEC-TEST-02 GCP 実環境でのテストは `make demo-apply` 後の smoke 1本に限る。内容は human-idp の `/.well-known/openid-configuration` が 200 を返すことと、agent-op の `/xaa/token` が `client_assertion` なしで `invalid_client` を返すこと。CI では手動実行にする。
- DEC-TEST-03 CI のジョブは8本に固定する。`typecheck` / `lint` / `unit` / `integration` / `terraform fmt と validate` / `infra-tests`（forbidden-roles、forbidden-tf、no-runtime-mutation、invoker-matrix）/ `check:oidc-patches` / `check-deps` と `docs:*`（refs、deviations、traceability）。GCP 認証を要求するジョブを作らない。
- DEC-TEST-04 フェーズとタスクの完了条件は、実行できるコマンドか観測できる出力で書く。「〜を作る」「〜を書く」で終わる完了条件を置かない。Policy Engine の回帰テストで assert する中間値は `proposed_capabilities` の集合、`effective_capabilities` の集合、`isolation_level`、denied 各件の `reason_code`、`allowed_tools` の集合 の5つに固定する。

## 費用
- DEC-COST-01 既定プロファイル（issuer_profile=direct、enable_google_bridge=false、Cloud SQL なし）を起動したまま放置した場合の月額固定費は約 $0.5 とする。内訳は Cloud KMS が約 $0.30（FULL_ISOLATION を動かした分の鍵バージョンは破棄予約後に課金が止まる）、Artifact Registry が約 $0.15、Secret Manager が約 $0.06 で、Cloud Run と Firestore と Pub/Sub と Cloud Scheduler と Cloud Logging と BigQuery は検証規模なら無料枠に収まる。8時間のデモ1回あたりの従量は Vertex AI が約 $0.7、Cloud Run が約 $0.4 で、1日あたり $1.1 から $1.5 に収まる。`make demo-destroy` 後の残存は約 $0.5/月。
- DEC-COST-02 費用に効く操作点を5つに固定し、すべて Terraform 変数として露出させる。`issuer_profile`、`enable_google_bridge`、`max_full_isolation_agents`、`agent_max_lifetime_seconds`、`enable_lb_reservation`。
