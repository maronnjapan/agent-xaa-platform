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
| `admin_principals` | list(string) | `[]` | 管理コンソール（権限とマッピング）を操作できる Google アカウントを指定する。空はだれも操作できない |
| `agent_max_lifetime_seconds` | number | `86400` | Agent の Job timeout と全期限の上限を決める |
| `audit_views_enabled` | bool | `true` | 保存済み検知 View を作る。Log Sink の宛先テーブルがまだ無い初回 apply でだけ false にする |
| `enable_deny_policy` | bool | `false` | 監査データ削除を拒否する IAM Deny Policy を有効にする |
| `enable_google_bridge` | bool | `false` | Google Bridge の内部面と Callback 面を配備する |
| `enable_lb_reservation` | bool | `false` | issuer 用の Global IP と証明書だけを予約する |
| `expiring_window_seconds` | number | `60` | 期限の何秒前から Agent を EXPIRING にするかを決める |
| `finance_absolute_max_amount` | number | `1000000` | Finance API が受理できる金額の絶対上限を決める |
| `google_oauth_client_id` | string | `""` | Google Auth Platform が発行した OAuth client ID。seed が Bridge の接続先定義に書く |
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

`scripts/deploy-gcp-guide.sh` は、GCP 認証、プロジェクト作成、請求先の関連付け、Terraform、Secret Manager、イメージ配布、SSO 鍵の初期化、seed、デモ用 Human Permission の付与、保存済み検知 View の作成、IAM 検証を順に実行する。
最後にログイン方法とコンソールの URL を表示して終わる。
リポジトリ直下の [README.md](../README.md) が、この手順を初めて使う人向けの入口である。

2回目以降の実行や `make destroy-all` の後の実行でも同じコマンドでよい。
state バケットは GCP に問い合わせて有無を判断し、削除できない KMS リソースは `scripts/adopt-existing-kms.sh` で state に取り込んでから apply する。
取り込む対象があるかどうかは GCP への2回の問い合わせで決めるため、KMS リソースを持たないプロジェクト（初回の配備）では Terraform を起動せずに数秒で終わる。

このスクリプトは端末からの入力を待たない。
`exec </dev/null` で自身の標準入力を外し、`CLOUDSDK_CORE_DISABLE_PROMPTS` と `TF_INPUT` を固定するため、gcloud や Terraform が内部で尋ねようとしても即座に EOF を受け取る。
出力を伏せた呼び出しの中で無言のまま入力を待ち続ける状態は起こらない。

後半で必要になる設定は、GCP を1つも変更していない起動直後にまとめて検査する。
`WORKFORCE_LOGIN_CONFIG`、`GOOGLE_OAUTH_CLIENT_ID`、OAuth client secret の渡し方、worktree が綺麗かどうかがこれにあたる。
足りないものは1件ずつではなく全部並べて報告して終わるため、指定し直して実行するのは1回で済む。

手でしかできない箇所は、スクリプトが URL と入力内容まで含めて画面に出す。
前提ツールの不足、請求先アカウントの作成、Google OAuth client の作成がこれにあたる。
組織ポリシー「ドメインの制限された共有」の例外は、まず `gcloud org-policies set-policy` でプロジェクト単位の上書きを試み、権限が無い場合だけコンソールの手順を出す（`AUTO_FIX_ORG_POLICY=0` で自動化を止める）。

通常の Google アカウントまたは Google Workspace の SSO を使う場合は、次のように実行する。
未ログインならブラウザが開き、ログイン済みならそのアカウントを使う。
`PROJECT_ID` を省くと `gcloud config` の project を使い、それも無ければ指定を促して終わる。
`BILLING_ACCOUNT_ID` を省くと、開いている請求先アカウントを自動で選ぶ。複数ある場合は先頭を使い、一覧と指定方法を表示する。

```bash
PROJECT_ID=<globally-unique-project-id> \
BILLING_ACCOUNT_ID=<XXXXXX-XXXXXX-XXXXXX> \
scripts/deploy-gcp-guide.sh all
```

demo state の変数は既定で `infra/tfvars/deploy.tfvars` を使い、main へのマージで配備する場合と同じ構成になる。

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

Bridge を有効にする場合、Bridge が読む `connector_definitions` の行は seed Job が書く。
`saas_connector_mode=stub` では `stub-saas-calendar` の1件を配備した stub SaaS へ向けて書き、client secret は stub が受け付ける固定値をスクリプトが `stub-bridge-client-secret` に登録する。

```bash
ENABLE_GOOGLE_BRIDGE=true \
scripts/deploy-gcp-guide.sh all
```

外部 Google OAuth を有効にする場合は、Google Auth Platform で Web application の OAuth client を作り、secret をファイルから渡す。
secret は `GOOGLE_OAUTH_CLIENT_SECRET_FILE`、または値を直接渡す `GOOGLE_OAUTH_CLIENT_SECRET` で受け取る。どちらも無く、Secret Manager にも有効な version が無ければ、起動直後の検査がそれを指摘して終わる。
承認済みリダイレクト URI は project number と region から決まるため、スクリプトが確定した値を表示する。
client ID は `GOOGLE_OAUTH_CLIENT_ID` で渡し、Terraform 変数 `google_oauth_client_id` を通して seed が `google-workspace` の行に書く。
catalog には Google Calendar を呼ぶ Tool を定義していないため、`google` モードで動くのは Bridge の同意と接続の保持までである。

```bash
ENABLE_GOOGLE_BRIDGE=true \
SAAS_CONNECTOR_MODE=google \
GOOGLE_OAUTH_CLIENT_ID=<client-id>.apps.googleusercontent.com \
GOOGLE_OAUTH_CLIENT_SECRET_FILE=/secure/path/client-secret.txt \
scripts/deploy-gcp-guide.sh all
```

### デプロイ後にアプリを操作する

Automation App の URL はスクリプトが最後に表示する。

ログインできるのは Human IdP が持つ固定ユーザーの `testuser` と `otheruser` の2人で、パスワードはどちらも `password` である。
seed が投入する `human_permissions` は `user-123` と `user-456` のもので、ログインする本人のものではない。
そのためスクリプトは `DEMO_LOGIN_USER`（既定は `testuser`）へ `document.read` `document.write` `finance.payment.read` `finance.payment.approve` を付与する。
Bridge を有効にした場合は `calendar.event.read` も付ける。

付与を省く場合は `GRANT_DEMO_PERMISSIONS=0` を指定する。
あとから増減する場合は次を実行する。

```bash
GOOGLE_CLOUD_PROJECT=<id> STORE_MODE=gcp PUBSUB_MODE=gcp \
  pnpm perm:set <user> <capability_id> <grant|revoke>
```

Automation App と Human IdP は `allUsers` へ公開され、ログイン情報は固定である。
検証が終わったら `make demo-destroy` で破棄する。

### 権限を作り、リソースへ対応付ける

権限（Capability）そのものを作る画面と、権限をリソースへ対応付ける画面は別のアプリにある。
どちらも Internet へ公開しないため（RULE-37）、ローカルへ proxy して開く。

```bash
gcloud run services proxy authorization --project=<id> --region=<region> --port=8081
# http://localhost:8081/admin/permissions で権限を作る、直す、消す

gcloud run services proxy provisioner --project=<id> --region=<region> --port=8082
# http://localhost:8082/admin/mappings で権限をリソースの操作へ対応付ける
```

proxy が付ける ID Token の `email` を、アプリは `ADMIN_PRINCIPALS` と突き合わせる。
`admin_principals` を空のまま apply した場合、`run.invoker` を持っていても画面は 403 を返す。

```hcl
# infra/tfvars/<env>.tfvars
admin_principals = ["you@example.com"]
```

`make seed`（と `deploy-gcp-guide.sh` の seed 手順）は `capability_taxonomy`、`delegatable_permissions`、`catalog_tools` を一度空にしてから YAML を書き直す。
画面で作った権限や変えた対応付けを残したいなら、`infra/seed/` の YAML にも同じ内容を入れる。

作った権限は、リソースへ対応付けるまで誰にも付与されない。
Organization Policy が、どの Connector にも対応しない Capability を拒否するためである。
対応付けたあと、その権限を人へ渡すのは上の `pnpm perm:set` である。

実行内容だけを確認する場合は `--dry-run` を付ける。

`tasks/done` の監査が失敗している間、スクリプトは GCP を変更する前に停止する。

監査結果を確認したうえで検証用デプロイを続ける場合に限り、`--allow-unverified` を付ける。

### main へのマージで配備する

`.github/workflows/deploy.yml` は、Pull Request が main にマージされたときの push で起動する。
state バケットの用意、既存 KMS リソースの import、`shared` の apply、Secret version の補充、イメージの build と push、`demo` の apply と IAM 検証、seed、保存済み検知 View の作成をこの順で実行する。
起動する経路はこの push だけで、手動実行の口は持たない。

Pull Request では ci、infra-static、infra-validate が動くため、main に届いたコミットはすでにそれらを通っている。
deploy はその検査を繰り返さず、apply だけを行う。

必要な設定は次の五つで、`GCP_PROJECT_ID` が無い場合は GCP へ触れる前に停止する。

| 種別 | 名前 | 効果 |
|---|---|---|
| Variable | `GCP_PROJECT_ID` | 配備先の GCP プロジェクトを指定する |
| Variable | `GCP_REGION` | リージョンを指定する。既定値は `asia-northeast1` |
| Variable | `DEMO_TFVARS` | demo state の変数ファイルを指定する。既定値は `infra/tfvars/deploy.tfvars` |
| Secret | `GCP_WORKLOAD_IDENTITY_PROVIDER` | GitHub Actions が使う Workload Identity 連携先を指定する |
| Secret | `GCP_DEPLOY_SERVICE_ACCOUNT` | Actions が偽装する配備用 Service Account を指定する |

配備用 Service Account には、Terraform が作るリソースの管理権限が必要になる。
`make demo-apply` が続けて実行する到達性検証は呼び出し元 Service Account を偽装するため、`make verify` は `scripts/verify-impersonation.sh` を経由し、不足している `roles/iam.serviceAccountTokenCreator` を実測の間だけ付与して終了後に削除する。
付与に要る `iam.serviceAccounts.setIamPolicy` は、Terraform が Service Account を作るために必要な `roles/iam.serviceAccountAdmin` に含まれるため、この検証のために足すロールは無い。
すでに恒久的に付与されている Service Account には何もしない。

Terraform は Secret の値を持たないため、version の無い Secret を Cloud Run が mount するとリビジョンが起動せず apply が失敗する。
`make ensure-secrets` は version の無い Secret にだけ生成した値を追加し、既存の version はそのまま使う。
`google-oauth-client-secret` は Google Auth Platform で発行する値なので補充せず、`stub-bridge-client-secret` は Bridge を有効にする配備だけが使う。
Bridge を有効にする配備は `scripts/deploy-gcp-guide.sh` から行う。

deploy と infra-destroy は同じ concurrency group を使うため、apply と destroy が同時に走ることはない。

`make all PROJECT_ID=<id>` はこのワークフローと同じ順序をローカルで実行する。

### 個別の Make ターゲットを使う

`make bootstrap PROJECT_ID=<id>` は state バケットを作る初回専用操作であり、通常は数分で終わる。
`make state-bucket PROJECT_ID=<id>` はバケットが無い場合だけ `bootstrap` を呼ぶ。
bootstrap の state は実行したマシンに残るため、無人実行では GCP へ問い合わせて判断する。
`make adopt-kms PROJECT_ID=<id>` は、プロジェクトに残っていて state に無い Key Ring と CryptoKey を import する。
`cloudkms.googleapis.com` が未有効か Key Ring が1つも無ければ、Terraform を起動せずに終わる。
import する件数と1件ごとの進行は標準出力に出る。
`make shared-apply PROJECT_ID=<id>` は共有 API と永続リソースを作り、初回の API 有効化を含む場合は十数分かかることがある。
`make ensure-secrets PROJECT_ID=<id>` は version の無い Secret にだけ生成した値を追加する。
`make images PROJECT_ID=<id> REGISTRY=<region>-docker.pkg.dev/<id>/xaa` は全アプリをビルドして、Git commit 由来のタグで push する。
`make demo-apply PROJECT_ID=<id> DEMO_TFVARS=infra/tfvars/demo.tfvars` は demo state を apply し、三つの IAM 実測を続けて実行する。
`reachability.sh` が Service Account を偽装するため、実行者には対象 SA に対する `roles/iam.serviceAccountTokenCreator` が必要になる。
`make verify` は `scripts/verify-impersonation.sh` を通り、不足している分だけを実測の間に付与して削除する。
実行者を判別できない環境では `VERIFY_PRINCIPAL` に IAM member 形式で指定する。
拒否ケースのうち FULL_ISOLATION の Agent 自身の Service Account と Dedicated OP を名指すものは、Provisioner が実行時に作る対象であり、まだ存在しないプロジェクトでは skipped と表示して測定しない。
ingress が internal のサービスも同じく skipped になる。VPC を持たないこの構成では Google Frontend が IAM を読む前に 404 を返すため、プロジェクトの外にいる実行者からは測りようがない（`infra/spike/RESULT.md` (a)）。
現在それに当たるのは `sa-pubsub-push` → `security-detection` の1本で、この経路が到達することは spike の (a) が Pub/Sub push で実測している。
`make seed PROJECT_ID=<id>` は JWKS 集約 Job の完了後に seed Job を実行する。
`make audit-views PROJECT_ID=<id>` は保存済み検知 View を作る。
View が読む `security_audit.run_googleapis_com_stdout` は、Cloud Run が stdout へ最初の1行を書いた時点で Cloud Logging が作るテーブルであり、一度もサービスを動かしていないプロジェクトには存在しない。
BigQuery は存在しないテーブルを参照する View を作成時に拒否するため、`shared-apply` はテーブルの有無を GCP に問い合わせ、無ければ View を作らずに進み、このターゲットが後から作る。
最大5分待ってもテーブルが現れない場合は失敗して終わるので、サービスがログを出したあとで実行し直す。
`make demo-destroy PROJECT_ID=<id>` は runtime 所有リソースを先に回収し、その後で demo state を破棄する。
`make destroy-all PROJECT_ID=<id>` は demo と shared の両方を破棄し、state バケットまで削除する。

### 作ったリソースを全て破壊する

`.github/workflows/infra-destroy.yml` は手動実行専用で、GCP プロジェクト自体を除く全てのリソースを削除する。
起動時に `confirm_project_id` へ `GCP_PROJECT_ID` と同じ値を入力する必要があり、一致しない場合は認証の前に停止する。
`delete_state_bucket` を false にすると state バケットだけを残す。

同じ処理はローカルからも実行できる。

```bash
PROJECT_ID=<id> TF=terraform make destroy-all
```

`scripts/destroy-all-resources.sh` は次の順で実行する。

1. `scripts/purge-runtime-resources.sh` で Provisioner が作った Dedicated OP のリソースを削除する
2. `demo` state を destroy する
3. `shared` state から KMS のリソースを `terraform state rm` で外し、残りを destroy する
4. `destroy_kms_key_versions` が true の場合だけ、残っている KMS 鍵バージョンの破棄を予約する
5. state が把握していないリソースを gcloud で掃除する
6. state バケットを削除する
7. `infra/tests/destroy-all-residue.sh` で残存を実測する

3 は、GCP が Key Ring と CryptoKey を削除できず `prevent_destroy` が付いているため、この二つを含む plan が必ず失敗することへの対処になる。

4 は既定で実行しない。
GCP は Key Ring も CryptoKey も削除できず、同じ鍵を作り直すこともできない。
DEC-IAC-04 はプラットフォームが使う鍵バージョンを 1 に固定しているため、バージョン 1 を破棄予約から復元できる 24 時間を過ぎると、そのプロジェクトでは二度とプラットフォームを動かせなくなる。
残る 5 バージョンの費用は月数十円であり、それがプロジェクトを再配備可能に保つ対価になる。
プロジェクトごと捨てる場合に限り `destroy_kms_key_versions` を true にする。

5 は、state を失った、または apply が途中で止まったプロジェクトでも空にできるようにするためにある。
2 と 3 が成功した後であれば削除対象は残っていない。

7 が一つでも残存を見つけた場合、ジョブは失敗する。

## destroy 後に残るもの

残るものは、どちらの destroy を使ったかで変わる。

### `make demo-destroy` の場合

GCP の KMS Key Ring と CryptoKey は削除できないため、`shared` state を破棄せずに残す。
再 apply では既存の `shared` state をそのまま使用するため、KMS リソースの import は不要になる。

state バケットは Terraform state の履歴を保持するために残す。
Artifact Registry は次の apply で同じイメージを再利用できるように残す。
既存の Cloud Logging ログもサービス削除とは独立した保持期間に従って残る。

### `make destroy-all` の場合

削除できない KMS の Key Ring と CryptoKey、およびその鍵バージョンだけが残る。
Provisioner が作った Agent ごとの鍵バージョンは手順 1 で破棄予約するため、残るのは `shared` state が作った 5 バージョンになる。

`shared` state が有効化した API は有効なままになる。
`disable_on_destroy = false` を指定しており、有効な API はリソースでも課金対象でもないためである。

Cloud Logging のログは削除しない。
サービスの削除とは独立した保持期間に従って消える。

この状態から再び配備する場合、deploy ワークフローは state バケットの作成からやり直す。
`make adopt-kms` が残った Key Ring と CryptoKey を state へ import するため、apply は既存の鍵をそのまま使う。
Firestore のデータと Human IdP の client secret は作り直しになる。

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
