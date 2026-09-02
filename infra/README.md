# GCP インフラストラクチャ

## 構成の前提

この構成は、利用者が指定した既存の GCP プロジェクトを一つだけ使用する。
Terraform は `google_project` リソースを作成せず、すべてのリソースへ同じ `project_id` を渡す。

Terraform state は `bootstrap`、`shared`、`demo` の三つに分ける。
`bootstrap` は versioning を有効にした state バケットを作り、`shared` は削除後も再利用する KMS、Artifact Registry、Secret Manager、監査データを管理する。
`demo` は Cloud Run、Firestore、Pub/Sub、Scheduler とアプリ用 IAM を管理し、繰り返し破棄できる。

データストアには名前付き Firestore データベース `xaa` だけを使用し、Cloud SQL は使用しない（DEV-05）。
Firestore IAM はコレクション単位に制限できないため、アプリごとの許可パスを `packages/gcp` のガードで検査する。

| 名前 | 型 | 既定値 | 効果 |
|---|---|---|---|
| `agent_max_lifetime_seconds` | number | `86400` | Agent の Job timeout と全期限の上限を決める |
| `enable_deny_policy` | bool | `false` | 監査データ削除を拒否する IAM Deny Policy を有効にする |
| `enable_google_bridge` | bool | `false` | Google Bridge の内部面と Callback 面を配備する |
| `enable_lb_reservation` | bool | `false` | issuer 用の Global IP と証明書だけを予約する |
| `expiring_window_seconds` | number | `60` | 期限の何秒前から Agent を EXPIRING にするかを決める |
| `finance_absolute_max_amount` | number | `1000000` | Finance API が受理できる金額の絶対上限を決める |
| `google_oauth_client_secret_value` | string or null | `null` | Google OAuth Client Secret の初期バージョンを任意で作る |
| `image_tag` | string | なし | Cloud Run が参照する不変イメージタグを指定する |
| `issuer_domain` | string | `issuer.example.invalid` | Load Balancer プロファイルの issuer ホストを指定する |
| `issuer_profile` | string | `direct` | issuer を Cloud Run 直結または Load Balancer に切り替える |
| `lifecycle_tick_cron` | string | `*/5 * * * *` | Lifecycle の定期 sweep 間隔を指定する |
| `max_full_isolation_agents` | number | `5` | FULL_ISOLATION Agent の同時上限を指定する |
| `project_id` | string | なし | すべての state が共有する一つの GCP プロジェクトを指定する |
| `region` | string | `asia-northeast1` | リージョナルリソースの配置先を指定する |
| `saas_connector_mode` | string | `stub` | Bridge の接続先を Stub または Google に切り替える |
| `security_events_delivery` | string | `pull` | Security Detection への配送方法。INTERNAL_ONLY のため既定は pull で、push は spike が到達を示した場合のみ |
| `vertex_location` | string | `us-central1` | Vertex AI API のロケーションを指定する |
| `vertex_model` | string | `gemini-2.5-flash` | 推論するモデル名をアプリへ注入する |

検証プロファイルは `infra/envs/demo/terraform.tfvars.verify` にあり、`agent_max_lifetime_seconds = 3600`、`lifecycle_tick_cron = "*/5 * * * *"`、`expiring_window_seconds = 60`、`max_full_isolation_agents = 5`、`issuer_profile = "direct"`、`enable_google_bridge = false` を使う。

## 運用手順

### プロジェクト作成から一括実行する

`scripts/deploy-gcp-guide.sh` は、GCP 認証、プロジェクト作成、請求先の関連付け、Terraform、Secret Manager、イメージ配布、SSO 鍵の初期化、seed、IAM 検証を順に実行する。

通常の Google アカウントまたは Google Workspace の SSO を使う場合は、次のように実行する。

```bash
PROJECT_ID=<globally-unique-project-id> \
BILLING_ACCOUNT_ID=<XXXXXX-XXXXXX-XXXXXX> \
GCP_AUTH_MODE=browser \
scripts/deploy-gcp-guide.sh all
```

Workforce Identity Federation を使う場合は、管理者から受け取った login config を指定する。

```bash
PROJECT_ID=<globally-unique-project-id> \
BILLING_ACCOUNT_ID=<XXXXXX-XXXXXX-XXXXXX> \
GCP_AUTH_MODE=workforce \
WORKFORCE_LOGIN_CONFIG=/secure/path/login-config.json \
scripts/deploy-gcp-guide.sh all
```

Terraform は Application Default Credentials を使う。

このスクリプトはサービスアカウント鍵 JSON を作らない。

Human IdP の二つの client secret はローカルで生成し、平文を表示せずに Secret Manager へ渡す。

SSO 署名鍵は Human IdP が初回アクセス時に生成し、KMS で包んだ状態で GCS に保存するため、スクリプトは秘密鍵を取得しない。

IAM 到達性検証では、実行者に不足している `roles/iam.serviceAccountTokenCreator` を対象 Service Account にだけ一時付与し、検証後に削除する。

外部 Google OAuth を有効にする場合は、Google Auth Platform で Web application の OAuth client を作り、secret をファイルから渡す。

```bash
ENABLE_GOOGLE_BRIDGE=true \
SAAS_CONNECTOR_MODE=google \
GOOGLE_OAUTH_CLIENT_SECRET_FILE=/secure/path/client-secret.txt \
scripts/deploy-gcp-guide.sh all
```

実行内容だけを確認する場合は `--dry-run` を付ける。

`tasks/done` の監査が失敗している間、スクリプトは GCP を変更する前に停止する。

監査結果を確認したうえで検証用デプロイを続ける場合に限り、`--allow-unverified` を付ける。

### 個別の Make ターゲットを使う

`make bootstrap PROJECT_ID=<id>` は state バケットを作る初回専用操作であり、通常は数分で終わる。
`make shared-apply PROJECT_ID=<id>` は共有 API と永続リソースを作り、初回の API 有効化を含む場合は十数分かかることがある。
`make images PROJECT_ID=<id> REGISTRY=<region>-docker.pkg.dev/<id>/xaa` は全アプリをビルドして、Git commit 由来のタグで push する。
`make demo-apply PROJECT_ID=<id> DEMO_TFVARS=infra/tfvars/demo.tfvars` は demo state を apply し、三つの IAM 実測を続けて実行する。
`reachability.sh` が Service Account を偽装するため、実行者には対象 SA に対する `roles/iam.serviceAccountTokenCreator` が必要になる。
`make seed PROJECT_ID=<id>` は JWKS 集約 Job の完了後に seed Job を実行する。
`make demo-destroy PROJECT_ID=<id>` は runtime 所有リソースを先に回収し、その後で demo state を破棄する。

## destroy 後に残るもの

GCP の KMS Key Ring と CryptoKey は削除できないため、`shared` state を破棄せずに残す。
再 apply では既存の `shared` state をそのまま使用するため、KMS リソースの import は不要になる。

state バケットは Terraform state の履歴を保持するために残す。
Artifact Registry は次の apply で同じイメージを再利用できるように残す。
既存の Cloud Logging ログもサービス削除とは独立した保持期間に従って残る。

## 費用の目安

常時課金は保存量と確保したリソース数に依存する。

| 項目 | 月額の目安 | 増える条件 |
|---|---:|---|
| Artifact Registry ストレージ | 数十円から数百円 | 保存するイメージ層が増える |
| state 用 GCS | 数十円 | state の世代数が増える |
| JWKS と config 用 GCS | 数十円 | オブジェクト世代と読み取りが増える |
| KMS 鍵バージョン | 数百円 | Dedicated Agent の鍵バージョンが増える |
| BigQuery ストレージ | 数十円から数百円 | 七日間の監査ログ量が増える |
| Firestore ストレージ | 数十円から数百円 | Agent、Activity、業務データが増える |
| 予約 Global IP | 数百円から数千円 | `enable_lb_reservation = true` にする |

従量課金はデモの実行量に依存する。

| 項目 | 課金要因 |
|---|---|
| Cloud Run | Service と Job の CPU 時間、メモリ時間、リクエスト数。`min_instance_count = 0` のため待機インスタンスを固定しない |
| Vertex AI | モデルごとの入力トークンと出力トークン |
| Pub/Sub | 配信するメッセージ量と保持量 |
| Cloud Logging | 取り込む構造化ログ量と保持量 |

## 単一プロジェクトによる保護の弱まり

単一プロジェクトでは、同じ Project Owner が実行系リソースと監査ログの両方へ到達できる。
二プロジェクト構成なら別の管理境界へ監査ログを置けるが、この構成ではその境界を作れない（DEV-14）。

`enable_deny_policy = false` のままでは、Owner による監査ログ削除を技術的に防げない。
代替統制として `infra/tests/forbidden-roles.sh` が Platform Service Account の強権限を実測し、許可していない付与を検出する。
