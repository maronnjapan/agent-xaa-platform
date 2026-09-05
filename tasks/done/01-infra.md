# 01. GCP基盤（Terraform）（T-IAC）

この領域は、プラットフォーム全体が載る GCP 上の土台を Terraform だけで組み立てる。
単一の GCP プロジェクトの中に、Cloud Run の Service と Job、専用 Service Account、KMS 鍵、Firestore、Pub/Sub、Cloud Scheduler、Cloud Logging と Log Sink、BigQuery 監査 dataset、GCS バケット、Artifact Registry を配置し、誰がどのサービスを呼べるかを IAM で固定する。
FULL_ISOLATION の Dedicated OP 一式だけは例外として Terraform で作らず、Provisioner が実行時に作る。Terraform はその入れ物と権限までを用意する。
アプリのコードは別領域が書くが、そのコードが読む接続先とモード切替の値は、この領域が Terraform の出力として供給する。
最後に、構成が意図どおりであることを機械的に検査するスクリプトと、apply から destroy までの運用手順を用意する。

| 前提 | 内容 |
|---|---|
| 依存する領域 | なし（全領域がこの領域に依存する。アプリのコンテナイメージだけは T-APP 系と Makefile を介して受け取る） |
| このファイルのタスク数 | 47件 |
| 主に満たす設計ルール | RULE-32, RULE-33, RULE-34, RULE-35, RULE-36, RULE-37, RULE-42, RULE-48, RULE-53, RULE-57 |

---

### T-IAC-01 前提4点を使い捨て Terraform で実測する

**概要**
以降のすべての構成が成り立つかどうかは、GCP の実挙動に依存する4点で決まる。
VPC を作らずに ingress を絞れるか、Cloud Run URL が決定論的な形式か、allUsers への公開が組織ポリシーで止められないか、Deny Policy が単一プロジェクトで使えるかを、使い捨ての Terraform で実測する。
DEC-SCOPE-02 が定める P0 の最初のタスクであり、これが終わるまで T-IAC-02 以降に着手しない。

**対象要件** REQ-08-041, REQ-08-043, REQ-05-031
**前提タスク** なし
**成果物** `infra/spike/main.tf`, `infra/spike/variables.tf`, `infra/spike/RESULT.md`, `infra/spike/probe/Dockerfile`, `infra/spike/probe/server.js`

**実装方針**
- 検証項目を次の4件に固定する。(a) `ingress = INGRESS_TRAFFIC_INTERNAL_ONLY` の Cloud Run Service へ、VPC を1つも作らない状態で、別 Cloud Run Service からの ID Token 付き呼び出し、Cloud Scheduler の OIDC 呼び出し、Pub/Sub push の3経路が到達するか。(b) `google_cloud_run_v2_service` の `uri` が `https://<service>-<project_number>.<region>.run.app` と一致するか。(c) `google_cloud_run_v2_service_iam_member` で `allUsers` に `roles/run.invoker` を付与できるか。(d) `google_iam_deny_policy` をこのプロジェクトの `cloudresourcemanager.googleapis.com/projects/<project_number>` に attach できるか。
- probe アプリは `/healthz` と `/echo` の2ルートだけを返す 30 行程度の Node スクリプトにする。ここで Hono を使わない。
- `RESULT.md` は 判定項目 / 実測コマンド / 出力の要点 / 判定（可 or 不可）/ 影響する DEC の5列表で書く。
- (a) が不可だった場合は `ingress = INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER` や VPC 導入へ流れず、まず `RESULT.md` に記録して DEC-IAC-14 の見直しとして起票する。この spike の中で代替構成を実装しない。
- (d) が可なら `enable_deny_policy` の既定を true にできる旨を `RESULT.md` に書く。既定値の変更そのものは T-IAC-41 で行う。
- spike のディレクトリは他 state の backend を共有しない。ローカル state で実行し、確認後に `terraform destroy` する。

**完了条件**
- [~] `infra/spike/RESULT.md` に4項目すべての判定行があり、空欄の列が無い（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する。spike は `terraform -chdir=infra/spike apply && destroy` を手で流して確認する）
- [~] `cd infra/spike && terraform apply && terraform destroy` が連続で成功する（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）
- [~] (b) の判定行に、実測した `uri` の文字列と、`project_number` と `region` から組み立てた文字列の完全一致を示す出力が引用されている（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する。spike は `terraform -chdir=infra/spike apply && destroy` を手で流して確認する）
- [x] `infra/spike/` 配下に `google_kms_*` と `google_sql_*` が1件も無い

---

### T-IAC-02 bootstrap / shared / demo の3 state と backend を作る

**概要**
Terraform の state を3つに分け、apply と destroy を繰り返す対象を demo だけに閉じ込める。
bootstrap は state 用 GCS バケットだけを作り、shared と demo はそのバケットを backend として使う。
DEC-IAC-01 に対応する。

**対象要件** なし（DEC-IAC-01）
**前提タスク** T-IAC-01
**成果物** `infra/bootstrap/main.tf`, `infra/bootstrap/variables.tf`, `infra/bootstrap/outputs.tf`, `infra/envs/shared/backend.tf`, `infra/envs/demo/backend.tf`, `infra/envs/shared/remote-state.tf` は作らず、`infra/envs/demo/remote-state.tf`

**実装方針**
- bootstrap は `google_storage_bucket "tfstate"` 1つだけを作る。名前は `${var.project_id}-tfstate`、`uniform_bucket_level_access = true`、`versioning { enabled = true }`、`force_destroy = false`、`location = var.region`。
- bootstrap の state はローカルファイルとし、`infra/bootstrap/terraform.tfstate` をコミットしない。`.gitignore` に追記する。
- shared の backend prefix は `state/shared`、demo の backend prefix は `state/demo` に固定する。
- demo 側の `remote-state.tf` に `data "terraform_remote_state" "shared"` を置き、bucket と prefix を直書きする。変数化しない。
- shared から demo を参照する向きの依存を作らない。参照は demo から shared への一方向だけにする。
- 3 state それぞれの直下に `README.md` を置かない。運用手順は T-IAC-47 の `infra/README.md` に集約する。

**完了条件**
- [~] `cd infra/bootstrap && terraform apply` の後、`gcloud storage buckets describe gs://<project_id>-tfstate` が `versioning.enabled: true` と `uniformBucketLevelAccess.enabled: true` を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `cd infra/envs/shared && terraform init` と `cd infra/envs/demo && terraform init` がどちらも backend 設定の入力を求めずに完了する（デプロイ後に `Makefile` の shared-apply / demo-apply 段が観測する）
- [x] `grep -rn "terraform_remote_state" infra/envs/shared/` が0件
- [x] `git check-ignore infra/bootstrap/terraform.tfstate` が exit code 0 を返す

---

### T-IAC-03 provider と terraform のバージョンを3 state でピン留めする

**概要**
provider の自動更新でプランが揺れると、以降の検査スクリプトがすべて信用できなくなる。
`required_version` と provider バージョンを exact 指定し、ロックファイルをコミットする。
DEC-IAC-02 に対応する。

**対象要件** なし（DEC-IAC-02）
**前提タスク** T-IAC-02
**成果物** `infra/bootstrap/versions.tf`, `infra/envs/shared/versions.tf`, `infra/envs/demo/versions.tf`, `infra/bootstrap/.terraform.lock.hcl`, `infra/envs/shared/.terraform.lock.hcl`, `infra/envs/demo/.terraform.lock.hcl`, `.github/workflows/infra-validate.yml`

**実装方針**
- `required_version` を `= 1.9.8` のように exact 指定する。範囲指定（`>=`、`~>`）を使わない。
- provider は `hashicorp/google` と `hashicorp/google-beta` の2つだけを宣言し、どちらも `version = "= 6.14.1"` の形で exact 指定する。3 state で同一バージョンにする。
- `google-beta` は `google_firestore_field` と `google_iam_deny_policy` のためだけに使う。使い所を `versions.tf` のコメントに1行で書く。
- `terraform init -upgrade` を CI で実行しない。CI は `terraform init -lockfile=readonly` を使い、ロックファイルと合わなければ落とす。
- `infra-validate.yml` は3 state それぞれで `terraform init -lockfile=readonly`、`terraform validate`、`terraform fmt -check -recursive` を実行する。

**完了条件**
- [x] `grep -rn 'version = "= ' infra/*/versions.tf infra/envs/*/versions.tf` が provider 宣言6件と `required_version` 3件の計9件ヒットし、`~>` と `>=` が0件
- [x] 3つの `.terraform.lock.hcl` が git 管理下にあり、`git status --porcelain infra/**/.terraform.lock.hcl` が空
- [x] CI ジョブ `infra-validate` が3 state すべてで green（実体は `.github/workflows/infra-validate.yml`）
- [x] `terraform init -lockfile=readonly` を provider バージョンを書き換えたブランチで実行すると exit code 1 になる

---

### T-IAC-04 単一プロジェクトの変数定義と14 API の有効化を書く

**概要**
プロジェクトは1つだけとし、2つ目のプロジェクト変数を定義しない。
使う GCP API を `google_project_service` で明示的に有効化し、apply が空プロジェクトから通る状態にする。
REQ-08-001 に対応する。

**対象要件** REQ-08-001
**前提タスク** T-IAC-03
**成果物** `infra/envs/shared/variables.tf`, `infra/envs/shared/services.tf`, `infra/envs/shared/provider.tf`, `infra/envs/demo/variables.tf`, `infra/envs/demo/provider.tf`, `infra/tests/single-project.sh`

**実装方針**
- 変数は `project_id`（string、必須）、`region`（string、既定 `asia-northeast1`）の2つをプロジェクト識別に使う。`security_project_id` のような2つ目のプロジェクト変数を定義しない。
- `google_project_service` を `for_each` で回し、対象を `run` `iam` `cloudkms` `secretmanager` `firestore` `pubsub` `logging` `bigquery` `cloudscheduler` `aiplatform` `storage` `artifactregistry` `cloudresourcemanager` `iamcredentials` の14件にする。REQ-08-001 の `sqladmin` は DEC-IAC-09 により Cloud SQL を使わないため `iamcredentials` に置き換え、その旨を `services.tf` のコメントで1行明記する。
- 各 `google_project_service` に `disable_on_destroy = false` を設定する。demo の destroy で API が無効化されないようにする。
- `google_project` リソースを書かない。プロジェクトは既存のものを受け取る。
- `infra/tests/single-project.sh` は `grep -rnE 'security[-_]project|agent-security-prod' infra/` と `grep -rcE 'variable "[a-z_]*project[a-z_]*"' infra/envs/*/variables.tf` の2つを実行し、前者が0件、後者が state ごとに1件であることを確認する。

**完了条件**
- [~] 空プロジェクトに対して `cd infra/envs/shared && terraform apply -auto-approve` が成功する（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）
- [~] `gcloud services list --enabled --project <project_id> --format='value(config.name)'` に14件がすべて含まれる（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [x] `bash infra/tests/single-project.sh` が exit code 0 を返す
- [x] `grep -rn 'agent-security-prod' infra/` が0件

---

### T-IAC-05 アプリごとの Service Account を作るモジュールと SA 台帳を書く

**概要**
デフォルトの compute Service Account を使わず、アプリごとに専用 SA を作る。
SA の一覧を1つの locals 台帳に集め、以降の IAM タスクがすべてこの台帳を参照する形にする。
RULE-35 と DEC-IAC-17 に対応する。

**対象要件** REQ-08-046, REQ-08-047
**前提タスク** T-IAC-04
**成果物** `infra/modules/service-account/main.tf`, `infra/modules/service-account/variables.tf`, `infra/modules/service-account/outputs.tf`, `infra/envs/demo/service-accounts.tf`, `infra/envs/demo/locals-sa.tf`

**実装方針**
- モジュールの入力は `account_id`（string）、`display_name`（string）、`project_id`（string）の3つ。出力は `email` と `member`（`serviceAccount:<email>` 形式）の2つ。
- `locals.service_accounts` に固定 SA を並べる。`sa-human-idp` `sa-automation-app` `sa-authorization` `sa-provisioner` `sa-lifecycle` `sa-shared-agent-op` `sa-google-bridge` `sa-security` `sa-resource-finance-as` `sa-resource-finance-api` `sa-resource-docs-as` `sa-resource-docs-api` `sa-agent-runtime` `sa-scheduler` `sa-pubsub-push` `sa-seed` `sa-jwks-publish` `sa-stub-saas-op` の18件。
- `sa-op-<short>` と `sa-agent-<short>` は Provisioner が実行時に作るため、この台帳に書かない。台帳のコメントに「この2種は実行時作成であり Terraform では作らない」と1行書く（DEC-IAC-07）。
- `account_id` は6文字以上30文字以下という GCP 制約に収まることを、モジュールの `variable validation` で `can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.account_id))` により検査する。
- `google_service_account_key` を作らない。認証は Cloud Run のワークロード ID に依存する。

**完了条件**
- [~] `terraform apply` 後、`gcloud iam service-accounts list --format='value(email)'` に台帳の18件がすべて現れる（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [x] `grep -rn 'google_service_account_key' infra/` が0件
- [x] `account_id` に `sa-x` を渡した plan が variable validation のエラーで失敗する
- [x] `grep -rn 'compute@developer.gserviceaccount.com' infra/` が0件

---

### T-IAC-06 Cloud Run Service の共通モジュールを作る

**概要**
常設の Service を1つのモジュールから作り、ingress と scaling と SA の既定値を1か所で決める。
デフォルト SA の指定を variable validation で apply エラーにする。
REQ-08-004 に対応する。

**対象要件** REQ-08-004
**前提タスク** T-IAC-05
**成果物** `infra/modules/cloud-run-service/main.tf`, `infra/modules/cloud-run-service/variables.tf`, `infra/modules/cloud-run-service/outputs.tf`, `infra/tests/cloud-run-defaults.sh`

**実装方針**
- 必須入力は `name`、`image`、`service_account`、`project_id`、`region` の5つ。`ingress` は既定 `INGRESS_TRAFFIC_INTERNAL_ONLY`。
- 任意入力は `env`（map(string)、既定 `{}`）、`secret_env`（map(object({secret=string, version=string}))、既定 `{}`）、`max_instance_count`（既定 2）、`memory`（既定 `512Mi`）、`cpu`（既定 `1`）、`timeout_seconds`（既定 300）。
- `scaling.min_instance_count` は 0 固定でモジュール入力にしない。待機課金を発生させる分岐を作らない。
- `variable "service_account"` に validation を2本置く。1本目は空文字を拒否する。2本目は `can(regex("-compute@developer\\.gserviceaccount\\.com$", var.service_account))` が true なら失敗させる。
- `resources.cpu_idle = true`、`execution_environment = EXECUTION_ENVIRONMENT_GEN2` を固定する。
- `vpc_access` ブロックを書かない。`google_vpc_access_connector` への参照をモジュール内に持たない。
- 出力は `name`、`service_account`、`uri` の3つ。ただし他タスクが URL を参照するときは T-IAC-07 の locals を使い、この `uri` を使わない。理由をモジュールの outputs.tf にコメント1行で書く。
- `infra/tests/cloud-run-defaults.sh` は `terraform plan -json` を `jq` で走査し、全 `google_cloud_run_v2_service` の `template.scaling.min_instance_count` が 0 であることと、`service_account` が `-compute@developer.gserviceaccount.com` で終わらないことを検査する。

**完了条件**
- [~] `service_account` を省略した呼び出しで `terraform plan` が variable validation のエラーで失敗する（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）
- [x] `service_account = "123-compute@developer.gserviceaccount.com"` を渡した plan が失敗する
- [x] `bash infra/tests/cloud-run-defaults.sh` が exit code 0 を返す
- [x] `grep -rn 'vpc_access' infra/modules/cloud-run-service/` が0件

---

### T-IAC-07 Cloud Run URL を locals で決定論的に組み立て platform_endpoints を書き出す

**概要**
issuer と audience と resource は plan 時点で確定していなければ、Agent OP の設定にも Catalog の seed にも流し込めない。
Cloud Run URL を `https://<service>-<project_number>.<region>.run.app` の形で locals から組み立て、解決済みの値を GCS オブジェクトとして出力する。
DEC-IAC-05 と DEC-IAC-06 に対応する。

**対象要件** なし（DEC-IAC-05, DEC-IAC-06）
**前提タスク** T-IAC-06
**成果物** `infra/envs/demo/locals-endpoints.tf`, `infra/envs/demo/platform-endpoints.tf`, `infra/envs/demo/outputs.tf`, `infra/tests/endpoints-shape.sh`

**実装方針**
- `data "google_project" "this"` から `number` を取り、`locals.run_url = { for s in local.service_names : s => "https://${s}-${data.google_project.this.number}.${var.region}.run.app" }` を作る。
- 他のどのファイルからも `google_cloud_run_v2_service.*.uri` を参照しない。参照は `local.run_url[...]` に統一する。
- `locals.platform_endpoints` を次のキーで組み立てる。`issuer`（`issuer_profile` により human-idp の URL または LB ホスト）、`jwks_uri`、`xaa_token_url`、`xaa_callback_url`、`subject_token_url`、`authorization_url`、`provisioner_url`、`lifecycle_url`、`resource_docs_as_issuer`、`resource_docs_api_resource`、`resource_finance_as_issuer`、`resource_finance_api_resource`、`bridge_internal_url`、`stub_saas_op_issuer`、`agent_max_lifetime_seconds`、`vertex_model`、`vertex_location`。
- `google_storage_bucket_object "platform_endpoints"` を非公開バケット `${var.project_id}-platform-config` の `platform-endpoints.json` として作り、`content = jsonencode(local.platform_endpoints)` を書く。
- 同じ内容を `output "platform_endpoints"` としても出す。`sensitive = false` にする。秘密値をこのマップに入れない。
- `infra/tests/endpoints-shape.sh` は apply 後に `gcloud storage cat` でオブジェクトを取得し、上記キーがすべて存在すること、`issuer` と `jwks_uri` が `https://` で始まることを `jq` で検査する。

**完了条件**
- [x] `grep -rn 'google_cloud_run_v2_service\..*\.uri' infra/envs/` が0件
- [~] `terraform plan` の出力に `platform-endpoints.json` の `content` が `(known after apply)` ではなく具体値として現れる（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）
- [x] `bash infra/tests/endpoints-shape.sh` が exit code 0 を返す
- [~] `terraform output -json platform_endpoints | jq -e 'has("slots") | not'` が成功する（実行時作成のリソースは endpoints に載せない）（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）

---

### T-IAC-08 常設サービス台帳と Control Plane 系 Cloud Run Service を定義する

**概要**
デプロイ単位を Terraform の Cloud Run Service と Job として固定し、アプリ内モジュールに留めるものを独立サービスにしない。
Control Plane にあたる5サービスを共通モジュールから作る。
REQ-01-009 と REQ-08-005 に対応する。

**対象要件** REQ-01-009, REQ-08-005
**前提タスク** T-IAC-07
**成果物** `infra/envs/demo/locals-services.tf`, `infra/envs/demo/services-controlplane.tf`, `infra/tests/service-inventory.sh`

**実装方針**
- `locals.service_names` に常設 Service 名を並べる。`human-idp` `automation-app` `authorization` `provisioner` `lifecycle` `shared-agent-op` `agent-op-callback` `security-detection` `resource-finance-as` `resource-finance-api` `resource-docs-as` `resource-docs-api` の12件を必ず含める。`google-bridge` `google-bridge-callback` `stub-saas-op` は `enable_google_bridge` で条件付きに加える。
- このタスクで作るのは `automation-app`（SA=`sa-automation-app`、ingress=`INGRESS_TRAFFIC_ALL`）、`authorization`（`sa-authorization`、INTERNAL）、`provisioner`（`sa-provisioner`、INTERNAL）、`lifecycle`（`sa-lifecycle`、INTERNAL）、`security-detection`（`sa-security`、INTERNAL）の5件。
- 各サービスの `image` は `"${local.registry_host}/${var.project_id}/xaa/${name}:${var.image_tag}"` の形で組み立てる。`image_tag` は変数（既定 `latest` を使わず、既定値を持たせない必須変数にする）。
- `automation-design-ai` `authorization-ai-agent` `policy-engine` `tool-executor` という名前の Cloud Run リソースを作らない。これらは Automation App と Authorization Platform と Agent Runtime のコード内モジュールとする。
- 共通の環境変数として `PROJECT_ID` `REGION` `PLATFORM_ENDPOINTS_URI`（`gs://` 形式）`STORE_MODE=gcp` `PUBSUB_MODE=gcp` `SIGNER_MODE=kms` `VERTEX_MODE=live` を注入する。アプリ固有の値だけを個別に足す。
- `infra/tests/service-inventory.sh` は `terraform plan -json` を走査し、`google_cloud_run_v2_service` の名前集合が `locals.service_names` と完全一致すること、禁止4名が現れないことを検査する。

**完了条件**
- [~] `terraform apply` 後、`gcloud run services list --format='value(metadata.name)'` が `locals.service_names` と同じ集合を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [x] `bash infra/tests/service-inventory.sh` が exit code 0 を返す
- [~] `gcloud run services describe authorization --format='value(spec.template.spec.serviceAccountName)'` が `sa-authorization@` で始まる値を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `terraform plan` を `image_tag` 未指定で実行すると必須変数のエラーで失敗する（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）

---

### T-IAC-09 Identity 系サービスを定義し /xaa/token を内部限定にする

**概要**
Human IdP と Shared Agent OP と Agent OP Callback を作る。
`/xaa/token` は Agent Runtime だけが呼ぶため内部限定にし、ブラウザが到達する `/xaa/callback` を別サービスへ分離する。
REQ-05-031 と REQ-08-014 に対応する。

**対象要件** REQ-05-031, REQ-08-014
**前提タスク** T-IAC-08
**成果物** `infra/envs/demo/services-identity.tf`

**実装方針**
- `human-idp`（SA=`sa-human-idp`、ingress=`INGRESS_TRAFFIC_ALL`）、`shared-agent-op`（`sa-shared-agent-op`、`INGRESS_TRAFFIC_INTERNAL_ONLY`）、`agent-op-callback`（`sa-shared-agent-op`、`INGRESS_TRAFFIC_ALL`）の3件を作る。
- `shared-agent-op` と `agent-op-callback` は同一イメージを使い、環境変数 `AGENT_OP_ROLE=token` と `AGENT_OP_ROLE=callback` で面を切り替える。イメージを2種類に分けない。
- `shared-agent-op` に注入する環境変数は `AGENT_ID` を持たせず、`ISOLATION_MODE=shared` を与える。Dedicated OP との差はこの1つだけにする。
- `human-idp` に `ISSUER`、`JWKS_URI`、`JWKS_BUCKET`、`JWKS_KEY_PREFIX=idp`、`SSO_KEY_WRAP_KMS_KEY` を注入する。
- `shared-agent-op` に `ISSUER`（Human IdP と同一文字列）、`IDJAG_KMS_KEY`（`shared-agent-op-idjag` の完全修飾名）、`IDP_CONNECTION_KMS_KEY`、`JWKS_KEY_PREFIX=agent-op`、`ALLOWED_AUDIENCES`（2つの Resource AS issuer の JSON 配列）、`ALLOWED_RESOURCES`（2つの Resource API URL の JSON 配列）を注入する。
- `run.invoker` の付与はこのタスクで書かず、T-IAC-15 の `invoker_edges` に集約する。

**完了条件**
- [~] `gcloud run services describe shared-agent-op --format='value(spec.template.metadata.annotations)'` の ingress が `internal` を示す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `gcloud run services describe agent-op-callback` の ingress が `all` を示す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] 認証なしのインターネット経由 `curl $(terraform output -raw xaa_token_url)/xaa/token` が 403 を返す（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）
- [~] 認証なしの `curl -o /dev/null -w '%{http_code}' <agent-op-callback URL>/livez` が 200 を返す（デプロイ後に `infra/tests/reachability.sh` が観測する）
- [x] `human-idp` と `shared-agent-op` の `ISSUER` 環境変数の値がバイト一致する

---

### T-IAC-10 リソースサーバー2種の4サービスと識別子変数を定義する

**概要**
金融系とドキュメントアプリの2種のリソースサーバーを、Authorization Server と Resource API に分けた合計4サービスとして作る。
各系統の issuer と resource と scope を Terraform の値として確定し、Agent OP の許可リストへ流し込む。
REQ-08-045 に対応する。

**対象要件** REQ-08-045
**前提タスク** T-IAC-09
**成果物** `infra/envs/demo/services-resource.tf`, `infra/envs/demo/locals-resource.tf`

**実装方針**
- 作るのは `resource-docs-as`（SA=`sa-resource-docs-as`）、`resource-docs-api`（`sa-resource-docs-api`）、`resource-finance-as`（`sa-resource-finance-as`）、`resource-finance-api`（`sa-resource-finance-api`）の4件。すべて `INGRESS_TRAFFIC_INTERNAL_ONLY`。
- AS と API を同一 Cloud Run Service に相乗りさせない。SA も4つに分ける。
- `locals.resource_servers` を次の形で定義する。`docs = { issuer = local.run_url["resource-docs-as"], resource = local.run_url["resource-docs-api"], scopes = ["docs.read", "docs.write"] }`、`finance = { issuer = local.run_url["resource-finance-as"], resource = local.run_url["resource-finance-api"], scopes = ["finance.tx.read", "finance.tx.write"] }`。
- scope 名は specs 5.0 の確定値を使う。REQ-08-045 に書かれた `transactions.read` `transfers.write` `documents.read` `documents.write` を Terraform に登場させない。
- 各 AS に `AS_KIND=docs` または `AS_KIND=finance`、`ISSUER`、`RESOURCE`、`ALLOWED_SCOPES`（JSON 配列）、`SIGNING_KEY_WRAP_KMS_KEY`、`JWKS_BUCKET`、`JWKS_KEY_PREFIX=res-docs` または `res-finance` を注入する。
- 各 API に `AS_ISSUER`、`RESOURCE`、`FIRESTORE_COLLECTION`（`documents` または `payments`）を注入する。`resource-finance-api` にのみ `REQUIRE_ISOLATION_LEVEL=full_isolation` を注入する。
- 2つの AS が同一 KMS 鍵を参照しないことを、`locals` の鍵名マップを分けることで構造的に担保する。

**完了条件**
- [~] `gcloud run services list --format='value(metadata.name)'` に4サービスが現れ、それぞれ異なる `serviceAccountName` を持つ（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [x] `grep -rnE 'transactions\.read|transfers\.write|documents\.read|documents\.write' infra/` が0件
- [~] `terraform output -json platform_endpoints | jq -r '.resource_finance_as_issuer'` が `https://resource-finance-as-` で始まる（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）
- [~] `gcloud run services describe resource-finance-api --format='value(spec.template.spec.containers[0].env)'` に `REQUIRE_ISOLATION_LEVEL=full_isolation` が含まれ、`resource-docs-api` には含まれない（デプロイ後に `infra/tests/verify-all.sh` が観測する）

---

### T-IAC-11 Bridge の2面と stub SaaS OP を条件付きで定義する

**概要**
OAuth Bridge を公開 Callback 面と内部 API 面の2 Cloud Run Service に分け、外部 SaaS の代わりに stub OAuth AS を立てる。
どちらも `enable_google_bridge` と `saas_connector_mode` で既定 apply の対象から外す。
REQ-06-001 と REQ-06-020 に対応する。

**対象要件** REQ-06-001, REQ-06-020
**前提タスク** T-IAC-10
**成果物** `infra/envs/demo/services-bridge.tf`, `infra/envs/demo/variables-bridge.tf`

**実装方針**
- 変数 `enable_google_bridge`（bool、既定 false）と `saas_connector_mode`（string、既定 `stub`、`validation` で `stub` と `google` の2値に限定）を定義する。
- `google-bridge`（SA=`sa-google-bridge`、INTERNAL、`BRIDGE_ROLE=internal`）と `google-bridge-callback`（同 SA、ALL、`BRIDGE_ROLE=callback`）を `count = var.enable_google_bridge ? 1 : 0` で作る。同一イメージを使う。
- `stub-saas-op`（SA=`sa-stub-saas-op`、ALL）を `count = var.enable_google_bridge && var.saas_connector_mode == "stub" ? 1 : 0` で作る。
- `saas_connector_mode = "google"` のとき Secret Manager の `google-oauth-client-secret` を `secret_env` として `google-bridge` に注入し、`stub` のときは注入しない。この分岐を1か所の `locals` にまとめる。
- ルーティングの絞り込み（callback 面が `/token` に 404 を返すなど）はアプリ側の責務とし、Terraform で `google_cloud_run_v2_service` の path 制御を試みない。
- `min_instance_count` は共通モジュールの 0 固定に従う。

**完了条件**
- [~] 既定値のまま `terraform plan` を実行すると `google-bridge` と `google-bridge-callback` と `stub-saas-op` が plan に現れない（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）
- [~] `terraform plan -var enable_google_bridge=true` で3サービスが現れる（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）
- [x] `-var enable_google_bridge=true -var saas_connector_mode=google` と `saas_connector_mode=stub` の plan 差分が、`google-bridge` 2面の `SAAS_CONNECTOR_MODE` 環境変数と `GOOGLE_OAUTH_CLIENT_SECRET` の Secret 参照、および stub SaaS 側サービス（`stub-saas-op` / `stub-saas-api`）とその公開 invoker の 有無だけである
- [x] `saas_connector_mode=azure` を渡した plan が variable validation で失敗する

---

### T-IAC-12 STANDARD 用 Agent Runtime Job と生存時間変数を定義する

**概要**
Agent は常駐サービスではなく Cloud Run Job Execution として動かす。
Job 定義に Agent 固有の値を持たせず、生存時間を1つの変数から導出する。
REQ-08-006 と REQ-07-037 に対応する。

**対象要件** REQ-08-006, REQ-07-037
**前提タスク** T-IAC-08
**成果物** `infra/modules/cloud-run-job/main.tf`, `infra/modules/cloud-run-job/variables.tf`, `infra/modules/cloud-run-job/outputs.tf`, `infra/envs/demo/jobs-runtime.tf`, `infra/envs/demo/variables-lifetime.tf`, `infra/tests/job-env.sh`

**実装方針**
- 変数 `agent_max_lifetime_seconds`（number、既定 86400、`validation` で 60 以上 86400 以下）を定義する。検証プロファイルでは 3600 を渡す。この1変数から Job の `task_timeout`、Registration の `expires_at` 上限、IdP Connection の期限、ID-JAG の exp cap、Lifecycle tick の判定窓をすべて導く。導出先のアプリへは環境変数 `AGENT_MAX_LIFETIME_SECONDS` で渡す。
- `cloud-run-job` モジュールの入力は `name`、`image`、`service_account`、`task_timeout_seconds`、`env`、`project_id`、`region`。`task_count = 1`、`parallelism = 1`、`max_retries = 0` を固定し、入力にしない。
- `agent-runtime-standard` を `sa-agent-runtime` で作る。`env` には `ISOLATION_MODE=shared` と共通の接続情報のみを入れる。`AGENT_ID`、`CLIENT_PRIVATE_KEY`、`XAA_CONFIG` に相当するキーを持たせない。Agent 固有の値は Execution の override で渡す。
- Agent Runtime 用の `google_cloud_run_v2_service` を書かない。
- `infra/tests/job-env.sh` は `terraform plan -json` を走査し、`google_cloud_run_v2_job` の env キー集合が `agent_id` `private_key` `client_secret` `refresh_token` のいずれにも部分一致しないことを検査する。

**完了条件**
- [~] `gcloud run jobs describe agent-runtime-standard --format='value(spec.template.template.timeoutSeconds)'` が `agent_max_lifetime_seconds` と一致する（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `gcloud run jobs describe agent-runtime-standard --format='value(spec.template.template.maxRetries)'` が 0 を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [x] `bash infra/tests/job-env.sh` が exit code 0 を返す
- [~] `terraform plan -json | jq -r '..|.type?|select(.=="google_cloud_run_v2_service")'` の結果に runtime を名前に含むものが無い（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）

---

### T-IAC-13 実行時作成の受け皿を Terraform に用意する

**概要**
FULL_ISOLATION の Dedicated OP 一式は Provisioner が実行時に作るため、Terraform では作らない（DEC-IAC-07）。
Terraform が用意するのは、鍵の置き場である KMS Key Ring と、実行時作成の同時数を縛る変数と、作られたリソースを見分けるためのラベル規約である。
REQ-01-010、REQ-05-056、REQ-08-007 に対応する。

**対象要件** REQ-01-010, REQ-05-056, REQ-08-007
**前提タスク** T-IAC-12
**成果物** `infra/envs/shared/kms.tf`（Key Ring 部分）, `infra/envs/demo/variables-isolation.tf`, `infra/envs/demo/locals-runtime-labels.tf`, `infra/tests/no-dedicated-op-in-tf.sh`

**実装方針**
- `idjag-signing` と `idp-connection-encryption` の Key Ring を shared state に作る。
  Key Ring は削除できないため demo state に置かない。
  Provisioner が実行時に作る CryptoKey はこの2つの Key Ring の中に入る。
- 変数 `max_full_isolation_agents`（number、既定 5、`validation` で 1 以上 20 以下）を定義する。
  Cloud Run Service へ環境変数 `MAX_FULL_ISOLATION_AGENTS` として渡す。
  この値は Provisioner の同時数チェック（T-PROV-25）が使う。
- `dedicated_slot_count` と `dedicated_op_slot_count` と `full_isolation_slot_count` という変数を定義しない。
- `locals-runtime-labels.tf` に `runtime_label_key = "xaa-managed"` と `runtime_label_value = "runtime"` を定義し、`terraform output` で公開する。
  Provisioner と Lifecycle と掃除スクリプトはこの値を参照し、ラベル名を各所に直書きしない。
- `dedicated-op-` / `sa-op-` / `sa-agent-` / `idjag-` / `idpconn-` / `agent-runtime-` で始まる名前のリソースを `*.tf` に書かない。
  この6接頭辞は実行時作成の名前空間として予約する。
- `infra/tests/no-dedicated-op-in-tf.sh` は `infra/**/*.tf` を走査し、上記6接頭辞のいずれかを `name` または `account_id` または `crypto_key_id` に持つリソース定義が0件であることを検査する。
  Terraform と実行時の両方が同じ名前を作りに行く事故を防ぐ。

**完了条件**
- [~] `terraform -chdir=infra/envs/shared apply` 後に `gcloud kms keyrings list --location=<region>` が `idjag-signing` と `idp-connection-encryption` を含む（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `terraform -chdir=infra/envs/demo output max_full_isolation_agents` が既定で `5` を返す（デプロイ後に `scripts/deploy-gcp-guide.sh` の verify 段が観測する）
- [x] `bash infra/tests/no-dedicated-op-in-tf.sh` が終了コード0で通る
- [x] `grep -rn "dedicated_slot_count\|isolation-slot" infra/` が0件になる（実体は `infra/tests/no-dedicated-op-in-tf.sh`）
- [~] `terraform -chdir=infra/envs/demo plan` の出力に `google_cloud_run_v2_service` として `dedicated-op-` で始まる名前が現れない（デプロイ後に `scripts/deploy-gcp-guide.sh` の verify 段が観測する）

---

### T-IAC-14 Dedicated OP 一式に付ける IAM の雛形を定義する

**概要**
Provisioner が実行時に作る Dedicated OP と専用 Runtime へ、どの権限を付けてどの権限を付けないかを1か所に定義する。
Terraform では作らないが、付与する内容は Terraform 管理の定数として置き、Provisioner はそれを読んで適用する。
これにより「何を付けたか」がコードとレビュー対象に残る。
REQ-05-058、REQ-05-059、REQ-08-022 に対応する。

**対象要件** REQ-05-058, REQ-05-059, REQ-08-022
**前提タスク** T-IAC-13
**成果物** `infra/envs/demo/locals-dedicated-iam.tf`, `packages/xaa-contracts/src/dedicated-iam.ts`, `infra/tests/dedicated-iam-shape.sh`

**実装方針**
- `locals-dedicated-iam.tf` に `dedicated_op_sa_roles` と `dedicated_agent_sa_roles` の2つのリストを定義し、`terraform output` で JSON として公開する。
- `sa-op-<short>` に付けるのは5件だけとする。
  自分の `idjag-<short>` への `roles/cloudkms.signerVerifier`。
  自分の `idpconn-<short>` への `roles/cloudkms.cryptoKeyEncrypterDecrypter`。
  Firestore の `roles/datastore.user`。
  JWKS バケットの `roles/storage.objectCreator`。
  `agent-activity-stream` の `roles/pubsub.publisher`。
- `sa-agent-<short>` に付けるのは6件だけとする。
  自分の `dedicated-op-<short>` への `roles/run.invoker`。
  `google-bridge` と `resource-docs-as` と `resource-finance-as` への `roles/run.invoker`。
  `roles/aiplatform.user`。
  Firestore の `roles/datastore.user`。
  `agent-activity-stream` の `roles/pubsub.publisher`。
- どちらにも Secret Manager の権限と、他 Agent の鍵への権限と、Provisioner と Lifecycle を呼ぶ権限を付けない。
- `sa-agent-<short>` に `shared-agent-op` への `roles/run.invoker` を付けない。
  共有 OP と Dedicated OP の相互到達を作らないためであり、docs 05 §5 の Blast Radius がこの1行に依存する。
- `packages/xaa-contracts/src/dedicated-iam.ts` は同じ内容を TypeScript の定数として持ち、Provisioner はこれを読んで Binding を作る。
  Terraform 側の output と TypeScript 側の定数が一致することを `infra/tests/dedicated-iam-shape.sh` が突き合わせる。
- 実行時に作った Binding が上記以外を含まないことは、T-PROV-24 の作成処理が定数だけを使うことで担保する。
  Provisioner のコードにロール名を直書きしない。

**完了条件**
- [x] `bash infra/tests/dedicated-iam-shape.sh` が終了コード0で通り、Terraform output と TypeScript 定数の差分が0件であることを出力する
- [x] `dedicated_op_sa_roles` の要素数が6（DEC-ID-19 の `/xaa/subject-token` のため `roles/secretmanager.secretAccessor` を含む）、`dedicated_agent_sa_roles` の要素数が6である
- [x] `grep -n "shared-agent-op" infra/envs/demo/locals-dedicated-iam.tf` が0件になる
- [x] `grep -rn "roles/" apps/provisioner/src` の結果が `dedicated-iam` を import する行だけになる

---

### T-IAC-15 run.invoker のエッジを1つの locals に集約して生成する

**概要**
どのアプリがどのアプリを呼べるかを1か所のマップで定義し、`for_each` で IAM Binding を生成する。
図に無い呼び出しへ invoker を付与しないことを、定義の網羅性で担保する。
REQ-01-022、REQ-05-012、REQ-08-021 と DEC-IAC-15 に対応する。

**対象要件** REQ-01-022, REQ-05-012, REQ-08-021
**前提タスク** T-IAC-14
**成果物** `infra/envs/demo/locals-invoker.tf`, `infra/envs/demo/iam-invoker.tf`

**実装方針**
- `locals.invoker_edges` を `{ "<caller_sa>|<target_service>" = { member = ..., service = ... } }` の1階層マップにする。ネストしたマップにしない。
- 定義するエッジは次のとおり。`sa-automation-app` → `authorization` `provisioner` `lifecycle`。`sa-authorization` → `lifecycle`。`sa-provisioner` → `shared-agent-op` `google-bridge` `agent-op-callback`。`sa-lifecycle` → `shared-agent-op` `dedicated-op-*` `google-bridge` `resource-docs-as` `resource-finance-as` `provisioner`。`sa-agent-runtime` → `shared-agent-op` `google-bridge` `resource-docs-as` `resource-finance-as`。`sa-agent-<short>` → `dedicated-op-<short>` `google-bridge` `resource-docs-as` `resource-finance-as`。`sa-security` → `lifecycle`。`sa-scheduler` → `lifecycle`。`sa-pubsub-push` → `authorization` `automation-app` `security-detection`。`sa-lifecycle` → `resource-docs-api` `resource-finance-api`（`/internal/revoke-by-actor` のため）。`sa-agent-runtime` と `sa-agent-<short>` → `resource-docs-api` `resource-finance-api`。
- `google-bridge` 宛のエッジは `enable_google_bridge` が true のときだけマップに入れる。
- `google_cloud_run_v2_service_iam_member` を `for_each = local.invoker_edges` で生成する。`google_cloud_run_v2_service_iam_binding` と `_iam_policy` を使わない。allUsers の付与だけは T-IAC-16 で別に書く。
- `google_project_iam_member` で `roles/run.invoker` を付与しない。プロジェクト全体への invoker を作らない。
- 図に無い組み合わせ（`sa-automation-app` → `shared-agent-op`、`sa-agent-runtime` → `authorization`、`sa-authorization` → `provisioner`）をマップに書かない。

**完了条件**
- [~] `terraform output -json invoker_edges | jq 'keys | length'` の値と、`gcloud run services get-iam-policy` を全サービスで集めた `roles/run.invoker` の member 件数（allUsers 分を除く）が一致する（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [x] `grep -rn 'google_project_iam_member' infra/ | grep 'run.invoker'` が0件
- [~] `sa-automation-app` の ID Token で `shared-agent-op` を呼ぶと 403 を返す（デプロイ後に `infra/tests/reachability.sh` が観測する）
- [~] `sa-agent-runtime` の ID Token で `authorization` を呼ぶと 403 を返す（デプロイ後に `infra/tests/reachability.sh` が観測する）

---

### T-IAC-16 公開サービスを限定し VPC を作らないことを固定する

**概要**
インターネットへ公開するのは既定で3サービス、Bridge 有効時でも5サービスに限る。
Serverless VPC Access Connector と VPC そのものを作らず、Cloud Run 間の通信を内部経路に閉じる。
REQ-08-041 と REQ-08-043 に対応する。

**対象要件** REQ-08-041, REQ-08-043
**前提タスク** T-IAC-15
**成果物** `infra/envs/demo/iam-public.tf`, `infra/envs/demo/locals-public.tf`, `infra/tests/public-surface.sh`

**実装方針**
- `locals.public_services` を、既定で `["automation-app", "human-idp", "agent-op-callback"]`、`enable_google_bridge = true` のとき `["google-bridge-callback"]` を、`saas_connector_mode = "stub"` のとき `["stub-saas-op"]` を加えたリストにする。
- `allUsers` への `roles/run.invoker` をこのリストの `for_each` だけで生成する。他の場所に `allUsers` を書かない。
- `ingress = INGRESS_TRAFFIC_ALL` を渡すのもこのリストのサービスに限る。共通モジュールの既定は INTERNAL_ONLY のままにする。
- `google_vpc_access_connector`、`google_compute_network`、`google_compute_subnetwork` を1つも書かない。`vpc_access` ブロックも書かない。
- `infra/tests/public-surface.sh` は `terraform plan -json` を走査し、(1) `ingress = INGRESS_TRAFFIC_ALL` のサービス名集合、(2) `allUsers` に invoker を付与したサービス名集合、の2つが `locals.public_services` と完全一致することを検査する。さらに `grep -rn 'google_vpc_access_connector\|google_compute_network' infra/envs infra/modules` が0件であることを確認する。
- 集合が一致しない場合の差分を、余分な側と不足側の両方で標準エラーに出す。

**完了条件**
- [x] `bash infra/tests/public-surface.sh` が既定変数で exit code 0 を返す
- [x] `authorization` に `ingress = INGRESS_TRAFFIC_ALL` を与えたブランチで `infra/tests/public-surface.sh` が exit code 1 を返す
- [x] `grep -rn 'allUsers' infra/envs/` のヒットが `iam-public.tf` の1ファイルのみ
- [~] `terraform plan -json | jq -r '..|.type?|select(startswith("google_compute_"))'` が既定変数で空（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）

---

### T-IAC-17 issuer_profile を切り替え LB の予約リソースを既定で作らない

**概要**
External Application Load Balancer は既定構成では1つも作らない。
`issuer_profile = direct` では issuer を human-idp の Cloud Run URL とし、`loadbalancer` を選んだときだけ URL Map とバックエンドを作る。
REQ-08-012、REQ-08-013、DEC-ID-04、DEC-IAC-20 に対応する。

**対象要件** REQ-08-012, REQ-08-013
**前提タスク** T-IAC-16
**成果物** `infra/envs/demo/variables-issuer.tf`, `infra/envs/demo/issuer-profile.tf`, `infra/modules/issuer-lb/main.tf`, `infra/modules/issuer-lb/variables.tf`, `infra/envs/shared/lb-reservation.tf`, `infra/tests/issuer-profile.sh`

**実装方針**
- 変数 `issuer_profile`（string、既定 `direct`、`validation` で `direct` と `loadbalancer` の2値）を定義する。
- `direct` では `google_compute_*` を1つも作らない。`local.platform_endpoints.issuer = local.run_url["human-idp"]`、`jwks_uri = "https://storage.googleapis.com/${local.jwks_bucket}/jwks.json"`、`xaa_token_url = local.run_url["shared-agent-op"]` とする。
- `loadbalancer` では `infra/modules/issuer-lb` を呼び、`/authorize` `/token` `/userinfo` `/logout` `/.well-known/openid-configuration` を human-idp のバックエンドへ、`/jwks.json` を JWKS バケットの Backend Bucket へ、`/xaa/token` を shared-agent-op へ、`/xaa/callback` を agent-op-callback へ振り分ける path_matcher を作る。
- 静的 IP アドレスとマネージド証明書は shared state の `lb-reservation.tf` に置き、変数 `enable_lb_reservation`（bool、既定 false）で切る。未使用の予約 IP が恒久課金にならないようにする。
- どちらのプロファイルでも ID-JAG の `iss` は human-idp の issuer 識別子と同じ文字列にする。`shared-agent-op` に渡す `ISSUER` を `local.platform_endpoints.issuer` から取り、別の値を組み立てない。
- `infra/tests/issuer-profile.sh` は `issuer_profile=direct` の plan で `google_compute_*` が0件であること、`loadbalancer` の plan で 5パスすべてが `path_matcher` に現れることを検査する。

**完了条件**
- [~] `terraform plan -var issuer_profile=direct -json | jq -r '..|.type?|select(startswith("google_compute_"))'` が空（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）
- [~] `terraform plan -var issuer_profile=loadbalancer` の出力に `/authorize` `/token` `/userinfo` `/logout` `/.well-known/openid-configuration` の5パスが現れる（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）
- [x] `bash infra/tests/issuer-profile.sh` が両プロファイルで exit code 0 を返す
- [x] 既定変数の shared state の plan に `google_compute_global_address` が現れない

---

### T-IAC-18 KMS Key Ring 5種と CryptoKey を shared state に作る

**概要**
署名鍵と暗号鍵を用途ごとの Key Ring に分け、鍵単位で IAM を付けられる形にする。
KMS 鍵は削除できないため shared state に置き、demo の destroy 対象から外す。
REQ-08-029、REQ-05-032、REQ-05-046、DEC-IAC-03、DEC-IAC-04、DEC-IAC-12 に対応する。

**対象要件** REQ-08-029, REQ-05-032, REQ-05-046
**前提タスク** T-IAC-04
**成果物** `infra/envs/shared/kms.tf`, `infra/envs/shared/outputs.tf`

**実装方針**
- Key Ring を5つ作る。`sso-signing` `idjag-signing` `resource-as-signing` `connector-encryption` `idp-connection-encryption`。すべて `location = var.region`。
- `idjag-signing` に `shared-agent-op-idjag` だけを作る。`purpose = ASYMMETRIC_SIGN`、`version_template.algorithm = EC_SIGN_P256_SHA256`。FULL_ISOLATION の `idjag-<short>` は Provisioner が実行時に同じ Key Ring の中へ作るため、Terraform では作らない。
- `sso-signing` に `human-idp-sso-wrap`、`resource-as-signing` に `resource-docs-as-wrap` と `resource-finance-as-wrap` を作る。いずれも `purpose = ENCRYPT_DECRYPT`。DEC-ID-17 により Human IdP と Resource AS の署名鍵は KMS の非対称鍵にできないため、封筒暗号用の対称鍵として作る。REQ-05-032 の RS256 指定との差異と、kid による分離が保たれる点を `kms.tf` のコメントに DEV-10 を引いて書く。
- `connector-encryption` に `google-connector`、`idp-connection-encryption` に `idp-connection` を作る。いずれも `purpose = ENCRYPT_DECRYPT`。FULL_ISOLATION の `idpconn-<short>` は実行時作成のため Terraform では作らない。
- 全 CryptoKey に `destroy_scheduled_duration = "86400s"` と `lifecycle { prevent_destroy = true }` を設定する。
- `google_kms_crypto_key_version` リソースを1つも書かない。初期バージョンは CryptoKey 作成時に GCP が暗黙生成するものだけを使う。
- shared の `outputs.tf` から全鍵の `id`（完全修飾名）をマップで出力し、demo が `terraform_remote_state` で受け取る。
- Key Ring は削除できないため shared state に置き、demo の destroy で消えないようにする。

**完了条件**
- [~] `gcloud kms keyrings list --location <region> --format='value(name)'` が5件を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `gcloud kms keys list --keyring idjag-signing --location <region> --format='value(versionTemplate.algorithm)'` が全件 `EC_SIGN_P256_SHA256` を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [x] `grep -rn 'google_kms_crypto_key_version' infra/` が0件（実体は `infra/tests/no-kms-key-version.sh`）
- [~] `cd infra/envs/demo && terraform destroy -auto-approve` の後に `gcloud kms keys list --keyring idjag-signing --location <region>` が依然として全鍵を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）

---

### T-IAC-19 KMS の権限を鍵単位で付与しプロジェクトレベルでは与えない

**概要**
署名と復号の権限を CryptoKey 単位でだけ付与し、プロジェクトレベルの KMS ロールを誰にも与えない。
これにより Agent OP が Human IdP の鍵で署名できず、Agent 間で鍵が混ざらない状態を作る。
REQ-08-030 に対応する。

**対象要件** REQ-08-030
**前提タスク** T-IAC-18, T-IAC-13
**成果物** `infra/envs/demo/iam-kms.tf`, `infra/envs/demo/locals-kms.tf`, `infra/tests/kms-iam.sh`

**実装方針**
- `locals.kms_bindings` を `{ "<key_name>|<sa_key>" = { key_id, member, role } }` の1階層マップにし、`google_kms_crypto_key_iam_member` を `for_each` で生成する。
- 付与するのは次の組み合わせだけ。`sa-shared-agent-op` → `shared-agent-op-idjag`（signerVerifier）。`sa-op-<short>` → `dedicated-op-<short>-idjag`（signerVerifier）。`sa-human-idp` → `human-idp-sso-wrap`（cryptoKeyEncrypterDecrypter）。`sa-resource-docs-as` → `resource-docs-as-wrap`（同）。`sa-resource-finance-as` → `resource-finance-as-wrap`（同）。`sa-google-bridge` → `google-connector`（同）。`sa-shared-agent-op` → `idp-connection`（同）。`sa-op-<short>` → `idpconn-<short>`（同）。`sa-lifecycle` → `idjag-signing` の全鍵（`roles/cloudkms.admin`、鍵バージョンの追加と無効化のため）。
- `google_project_iam_member` で `roles/cloudkms.*` を付与しない。`google_kms_key_ring_iam_member` も使わない。付与は CryptoKey 単位に限る。
- `sa-lifecycle` の `cloudkms.admin` は `idjag-signing` Key Ring の鍵だけに限る。他の Key Ring の鍵に付けない。
- `infra/tests/kms-iam.sh` は `terraform plan -json` を走査し、`google_project_iam_member` に `cloudkms` を含む role が0件であること、`google_kms_crypto_key_iam_member` の集合が `locals.kms_bindings` と完全一致することを検査する。

**完了条件**
- [x] `bash infra/tests/kms-iam.sh` が exit code 0 を返す
- [~] `gcloud projects get-iam-policy <project_id> --flatten=bindings --format='value(bindings.role)' | grep cloudkms` が0件（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `sa-shared-agent-op` の資格情報で `human-idp-sso-wrap` の decrypt を要求すると PERMISSION_DENIED になる（デプロイ後に `infra/tests/forbidden-roles.sh` が観測する）
- [~] `sa-op-aaaaaaaaaaaa` の資格情報で `dedicated-op-bbbbbbbbbbbb-idjag` の asymmetricSign を要求すると PERMISSION_DENIED になる（デプロイ後に `infra/tests/forbidden-roles.sh` が観測する）

---

### T-IAC-20 共有 JWKS バケットを作り書き込みを自分の鍵に限る

**概要**
公開鍵の配信をアプリではなく Cloud Storage から行う。
各アプリの SA には自分の prefix のオブジェクトへの作成権限だけを与え、削除権限を与えない。
REQ-08-016、REQ-05-027、REQ-10-010、DEC-IAC-13 に対応する。

**対象要件** REQ-08-016, REQ-05-027, REQ-10-010
**前提タスク** T-IAC-19
**成果物** `infra/envs/demo/storage-jwks.tf`, `infra/envs/demo/iam-jwks.tf`, `infra/tests/jwks-bucket.sh`

**実装方針**
- バケット名を `${var.project_id}-jwks` とし、`uniform_bucket_level_access = true`、`force_destroy = true`、`location = var.region`、`public_access_prevention = "inherited"` で作る。
- `allUsers` に `roles/storage.objectViewer` をバケットレベルで付与する。
- 書き込みは `roles/storage.objectCreator` だけを付与する。`roles/storage.objectAdmin` と `roles/storage.objectUser` と `roles/storage.legacyBucketWriter` を誰にも付与しない。
- prefix 限定は `google_storage_bucket_iam_member` の `condition` で行う。`resource.name.startsWith("projects/_/buckets/<bucket>/objects/keys/<prefix>-")` の形にする。prefix は `sa-human-idp` が `idp`、`sa-shared-agent-op` が `agent-op`、`sa-op-<short>` が `idjag-<n>`、`sa-resource-docs-as` が `res-docs`、`sa-resource-finance-as` が `res-finance`。
- `jwks.json` そのものへの書き込みは `sa-jwks-publish` にだけ許す。他の SA に `jwks.json` の作成権限を与えない。
- 空の `jwks.json` を `google_storage_bucket_object` として作らない。初回の公開は T-IAC-21 の Job が行う。
- `infra/tests/jwks-bucket.sh` は `terraform plan -json` を走査し、バケットが1つであること、削除を含むロールが誰にも付いていないこと、`issuer_profile=direct` の plan に `google_compute_*` が現れないことを検査する。

**完了条件**
- [x] `bash infra/tests/jwks-bucket.sh` が exit code 0 を返す
- [~] `sa-shared-agent-op` の資格情報で `gcloud storage rm gs://<bucket>/jwks.json` が PERMISSION_DENIED になる（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [x] `sa-shared-agent-op` の資格情報で `keys/idp-xxx.json` への書き込みが PERMISSION_DENIED になり、`keys/op-shared-1.json` への書き込みが成功する
- [~] 認証なしの `curl -o /dev/null -w '%{http_code}' https://storage.googleapis.com/<bucket>/jwks.json` が 200 を返す（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）

---

### T-IAC-21 jwks-publish Job で keys/ をマージして jwks.json を書き出す

**概要**
各アプリが自分の公開鍵を `keys/` へ置いた後、それらをマージして単一の `jwks.json` を作る。
アプリ同士が同じオブジェクトへ書き込む競合を避けるために、集約を専用の Cloud Run Job に分離する。
DEC-IAC-13 に対応する。

**対象要件** REQ-05-027, REQ-10-010
**前提タスク** T-IAC-20
**成果物** `infra/envs/demo/jobs-jwks-publish.tf`, `apps/jwks-publish/src/index.ts`, `apps/jwks-publish/package.json`, `apps/jwks-publish/test/merge.spec.ts`

**実装方針**
- Cloud Run Job `jwks-publish`（SA=`sa-jwks-publish`、`task_timeout_seconds = 120`）を `cloud-run-job` モジュールで作る。
- `sa-jwks-publish` に付与するのは JWKS バケットの `roles/storage.objectViewer` と、`jwks.json` に限定した条件付きの `roles/storage.objectCreator` の2件だけ。
- Job のロジックは、`keys/` プレフィックスの全オブジェクトを列挙し、各 JSON を `keys[]` として読み、`kid` で重複排除して `{ "keys": [...] }` を書き出す。`kid` が重複した場合は `updated` が新しい方を残す。
- `kid` の接頭辞が `idp-` `agent-op-` `idjag-` `res-docs-` `res-finance-` のいずれでもないオブジェクトを無視する。エラーにせずスキップし、スキップ件数を標準出力へ出す。
- `jwks.json` の書き込みに `if-generation-match` を使わない。Job は同時に1本しか走らせない前提とし、Makefile の `seed` ターゲットから直列で呼ぶ。
- 鍵の生成そのものは各アプリの自己ブートストラップ（DEC-ID-17）が行う。この Job で鍵を作らない。

**完了条件**
- [~] `gcloud run jobs execute jwks-publish --wait` が exit code 0 で完了する（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] 実行後の `curl -s https://storage.googleapis.com/<bucket>/jwks.json | jq '[.keys[].kid] | length'` が `keys/` のオブジェクト数と一致する（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）
- [x] `apps/jwks-publish/test/merge.spec.ts::deduplicates by kid keeping the newer entry` が green
- [x] `sa-jwks-publish` の資格情報で `keys/idp-1.json` の削除が PERMISSION_DENIED になる（実体は `infra/tests/jwks-bucket.sh`）

---

### T-IAC-22 Secret Manager の Secret を作りアクセスを Bridge だけに限る

**概要**
外部 SaaS の OAuth client secret を Secret Manager に置き、Bridge の SA だけが読める状態にする。
Terraform に値そのものを書かない。
REQ-08-034 と REQ-06-019 に対応する。

**対象要件** REQ-08-034, REQ-06-019
**前提タスク** T-IAC-11
**成果物** `infra/envs/shared/secrets.tf`, `infra/envs/shared/variables-secrets.tf`, `infra/envs/demo/iam-secrets.tf`, `infra/tests/secret-iam.sh`

**実装方針**
- `google_secret_manager_secret "google_oauth_client_secret"` を `secret_id = "google-oauth-client-secret"`、`replication { user_managed { replicas { location = var.region } } }` で作る。automatic replication を使わない。
- `google_secret_manager_secret_version` は変数 `google_oauth_client_secret_value`（string、`sensitive = true`、既定 `null`）が null でないときだけ `count` で作る。値は `terraform.tfvars` から与え、そのファイルを `.gitignore` に入れる。
- `roles/secretmanager.secretAccessor` を `google_secret_manager_secret_iam_member` で `sa-google-bridge` にだけ付与する。他の SA に付与しない。
- `google_project_iam_member` で `roles/secretmanager.*` を付与しない。
- Refresh Token を Secret Manager に置かない。Refresh Token は KMS で暗号化して Firestore に置く。この方針を `secrets.tf` のコメントに1行書く。
- `infra/tests/secret-iam.sh` は `terraform plan -json` を走査し、当該 Secret の IAM member が1件であること、plan の出力に `google_oauth_client_secret_value` の平文が現れないことを検査する。

**完了条件**
- [x] `bash infra/tests/secret-iam.sh` が exit code 0 を返す
- [~] `terraform plan` の出力に client secret の平文が現れず `(sensitive value)` と表示される（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）
- [~] `sa-provisioner` の資格情報で `gcloud secrets versions access latest --secret google-oauth-client-secret` が PERMISSION_DENIED になる（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `sa-google-bridge` の資格情報では同じコマンドが成功する（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）
- [~] `gcloud secrets get-iam-policy google-oauth-client-secret --format='value(bindings.members)'` が1件を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）

---

### T-IAC-23 Firestore データベースと activity の TTL を作る

**概要**
データストアを Firestore の Native mode 1本にする。
`users/{human_subject}/activity` の保持期間を7日にする TTL ポリシーを Terraform で設定する。
REQ-08-038、REQ-11-041、DEC-IAC-09、DEC-IAC-10 に対応する。

**対象要件** REQ-08-038, REQ-11-041
**前提タスク** T-IAC-04
**成果物** `infra/envs/demo/firestore.tf`, `infra/tests/no-firestore-rules.sh`

**実装方針**
- `google_firestore_database "default"` を `name = "(default)"`、`type = "FIRESTORE_NATIVE"`、`location_id = var.region`、`deletion_policy = "DELETE"`、`delete_protection_state = "DELETE_PROTECTION_DISABLED"` で作る。
- `google_firestore_field`（google-beta プロバイダ）で `collection = "activity"`、`field = "expire_at"`、`ttl_config {}` を設定する。コレクショングループ単位の設定になる点をコメントで書く。
- `expire_at` の値は書き込み側のアプリが `now + 7 日` として入れる。TTL の日数はアプリ側の定数とし、Terraform では日数を持たない。7日という値は `docs/11-activity-timeline.md` §4 に記載する（T-DOCS 領域）。
- `google_firebaserules_ruleset` と `google_firebaserules_release` を書かない。Security Rules を作らない。ブラウザからの直接アクセスの禁止は、フロントに Firestore SDK を含めないこと（T-IAC-44 で検査）とサーバ側パスガード（T-IAC-25）で担保する。
- `infra/tests/no-firestore-rules.sh` は `grep -rn 'google_firebaserules' infra/` が0件であること、`firestore.rules` というファイルがリポジトリに存在しないことを検査する。

**完了条件**
- [~] `gcloud firestore databases describe --database='(default)' --format='value(type)'` が `FIRESTORE_NATIVE` を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `gcloud firestore fields describe expire_at --collection-group=activity --format='value(ttlConfig.state)'` が `ACTIVE` を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [x] `bash infra/tests/no-firestore-rules.sh` が exit code 0 を返す
- [~] `terraform destroy` が Firestore データベースの削除保護で失敗しない（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）

---

### T-IAC-24 定義データのコレクション構成と複合インデックスを定義する

**概要**
Cloud SQL のテーブルとして書かれていた Capability Taxonomy とポリシー4種と Tool Catalog を、Firestore のコレクションとして定義する。
クエリに必要な複合インデックスを Terraform で作り、実行時のインデックス自動作成に依存しない。
REQ-03-004、REQ-03-009、REQ-04-001 に対応する。

**対象要件** REQ-03-004, REQ-03-009, REQ-04-001
**前提タスク** T-IAC-23
**成果物** `infra/envs/demo/firestore-indexes.tf`, `infra/schema/firestore-collections.md`, `packages/xaa-contracts/src/collections.ts`

**実装方針**
- コレクション名を次に確定する。`capability_taxonomy`（doc id = capability_id）、`human_permissions`（doc id = `<human_subject>|<capability_id>`）、`delegatable_permissions`（doc id = capability_id）、`organization_policies`（doc id = policy_id）、`risk_policies`（doc id = policy_id）、`catalog_connectors`（doc id = connector_id）、`catalog_tools`（doc id = tool_id）。
- 各コレクションのフィールド構成を `infra/schema/firestore-collections.md` に表で書く。`capability_taxonomy` は `resource` `object` `action` `description` `default_characteristics`（map、キーは `capability_risk` `resource_sensitivity` `admin_permission` `personal_data_access` `write_permission` `financial_operation`）。`catalog_tools` は `connector_id` `description` `required_capability` `auth_type` `audience` `resource` `scope` `token_provider` `api_base_url` `api_method` `api_path` `parameters` `response_schema` `constraints` `risk_level`。`catalog_connectors` は `resource_type` `authorization_audience` `authorization_resource` `bridge_audience` `status` `risk_level` `tools`。
- コレクション名の定数は `packages/xaa-contracts/src/collections.ts` に置き、Terraform とアプリで同じ名前を使う。Terraform 側は `firestore-indexes.tf` に文字列で直書きし、この2か所以外に名前を書かない。
- `google_firestore_index` を作るのは、`human_permissions`（`human_subject` 昇順 + `capability_id` 昇順）、`catalog_tools`（`connector_id` 昇順 + `required_capability` 昇順）、`documents`（`owner_subject` 昇順 + `type` 昇順 + `occurred_at` 降順）、`payments`（`requester_subject` 昇順 + `status` 昇順 + `created_at` 降順）、`activity`（`task_id` 昇順 + `occurred_at` 昇順、コレクショングループ）の5件。
- FK 相当の整合チェック（`catalog_tools.required_capability` が `capability_taxonomy` に存在すること）は seed Job の検証で行う。Firestore 側に制約を作らない。

**完了条件**
- [~] `gcloud firestore indexes composite list --format='value(name)'` が5件を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [x] `infra/schema/firestore-collections.md` に7コレクションすべての表があり、列が空のセルが無い
- [x] `grep -rn '"capability_taxonomy"' --include=*.ts packages/ apps/ | grep -v collections.ts` が0件
- [~] `terraform plan` が index 作成後に `No changes.` を返す（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）

---

### T-IAC-25 Cloud SQL 不採用を構成で固定し Firestore の許可マトリクスを出力する

**概要**
Cloud SQL を使わないため、論理DB と DB User による責務分離が使えない。
代わりに、どのアプリがどの Firestore パスへ到達してよいかの許可マトリクスを1ファイルで持ち、アプリ側のラッパで強制する。
REQ-01-012、REQ-08-035、REQ-08-036、REQ-08-037、REQ-03-020 の代替実装であり、DEV-05 に対応する。

**対象要件** REQ-01-012, REQ-08-035, REQ-08-036, REQ-08-037, REQ-03-020
**前提タスク** T-IAC-24
**成果物** `infra/envs/demo/firestore-access-matrix.tf`, `packages/gcp/src/firestore-guard.ts`, `packages/gcp/src/access-matrix.json`, `infra/tests/no-cloudsql.sh`

**実装方針**
- `google_sql_database_instance`、`google_sql_database`、`google_sql_user`、`google_project_iam_member` の `roles/cloudsql.*` を1つも書かない。
- `packages/gcp/src/access-matrix.json` を `{ "<app>": { "read": ["<path pattern>"], "write": ["<path pattern>"] } }` の形で書く。`<app>` は Cloud Run に注入される `APP_NAME` 環境変数の値と一致させる。
- マトリクスの内容を、REQ-08-037 の GRANT 表を Firestore パスへ読み替えて確定する。`authorization` は `human_permissions/**` `delegatable_permissions/**` `organization_policies/**` `risk_policies/**` の read と write、`capability_taxonomy/**` の read のみ、`catalog_*` への到達なし。`provisioner` は `catalog_connectors/**` `catalog_tools/**` の read のみ、`agents/**` `agent_registrations/**` `provisioning_transactions/**` `dedicated_resources/**` の read と write。`automation-app` は `agents/**` `users/*/activity/**` の read と write。`shared-agent-op` と `idjag-<n>` は `idp_connections/**` `agent_registrations/**` の read と write。`lifecycle` は `agents/**` `agent_registrations/**` `dedicated_resources/**` の read と write、`idp_connections/**` は delete のみ。`google-bridge` は `connector_bindings/**` の read と write のみ。
- `firestore-guard.ts` は `assertPath(app: string, mode: "read"|"write"|"delete", path: string): void` を公開し、マトリクスに合致しないときに `FirestoreGuardError` を throw する。パターンの照合は先頭一致ではなくセグメント単位のグロブで行い、`agents2/` が `agents/**` にマッチしないようにする。
- Dedicated OP 間の分離は `idp_connections/{agent_id}` と `agent_registrations/{agent_id}` の `agent_id` を、その Dedicated OP に注入された `AGENT_ID` と突き合わせて判定する。マトリクスとは別の関数 `assertAgentOwnership(ownAgentId, agentId)` に分ける。
- `infra/tests/no-cloudsql.sh` は `grep -rn 'google_sql_\|cloudsql' infra/` が0件であることを検査する。コメント中の言及も禁止する。

**完了条件**
- [x] `bash infra/tests/no-cloudsql.sh` が exit code 0 を返す
- [x] `packages/gcp/test/firestore-guard.spec.ts::denies cross-app path access` が green
- [x] `packages/gcp/test/firestore-guard.spec.ts::denies cross-agent path from runtime` が green
- [x] `packages/gcp/test/firestore-guard.spec.ts::agents2 does not match agents glob` が green
- [x] `access-matrix.json` の `authorization` エントリに `catalog_connectors` が現れず、`catalog_tools` は read にだけ現れて write には現れない（Authorization は REQ-03-021 の capability→connector 解決のために `catalog_tools` を読むが、Catalog を書き換える経路は持たない）

---

### T-IAC-26 Catalog と定義データを投入する seed Job を作る

**概要**
Connector と Tool と Capability とポリシーを、リポジトリ内の YAML を正として Firestore へ投入する。
宛先ホスト名は Terraform が書き出した `platform-endpoints.json` から解決し、Job の中で Terraform を実行しない。
REQ-04-002、REQ-04-003、REQ-04-007、REQ-04-008、DEC-IAC-06 に対応する。

**対象要件** REQ-04-002, REQ-04-003, REQ-04-007, REQ-04-008
**前提タスク** T-IAC-25, T-IAC-07
**成果物** `infra/envs/demo/jobs-seed.tf`, `infra/envs/demo/storage-seed.tf`, `infra/seed/connectors/internal-docs-api.yaml`, `infra/seed/connectors/internal-finance-api.yaml`, `infra/seed/connectors/google-workspace.yaml`, `infra/seed/tools/*.yaml`, `infra/seed/capabilities.yaml`, `infra/seed/policies/*.yaml`, `apps/seed/src/index.ts`, `apps/seed/src/resolve.ts`

**実装方針**
- Cloud Run Job `seed`（SA=`sa-seed`、`task_timeout_seconds = 600`）を作る。`env` に `PLATFORM_ENDPOINTS_URI`（`gs://<bucket>/platform-endpoints.json`）と `SEED_BUCKET` と `ENABLE_GOOGLE_BRIDGE` を渡す。
- YAML 群は `google_storage_bucket_object` で `${var.project_id}-platform-config` の `seed/` 配下へアップロードする。イメージに焼き込まない。`for_each = fileset("${path.module}/../../seed", "**/*.yaml")` で回す。
- `resolve.ts` は YAML 内の `${issuer:docs}` `${resource:docs}` `${issuer:finance}` `${resource:finance}` `${bridge:internal}` `${issuer:stub_saas}` という6種のプレースホルダだけを `platform-endpoints.json` の値で置換する。任意の式評価を行わない。未解決のプレースホルダが1つでも残ったら exit code 1 で終了する。
- 投入は全削除して再投入する。対象コレクションは `catalog_connectors` `catalog_tools` `capability_taxonomy` `human_permissions` `delegatable_permissions` `organization_policies` `risk_policies` の7つ。それ以外のコレクションへ書き込まない。
- Connector は `internal-docs-api`（`resource_type=native_xaa`、`risk_level=medium`、tools 4件）と `internal-finance-api`（`native_xaa`、`high`、tools 3件）を必ず投入し、`google-workspace`（`oauth_bridge`、tools 4件）は `ENABLE_GOOGLE_BRIDGE=true` のときだけ投入する。
- Tool の `tool_id` と `required_capability` と `scope` は specs 5.0 の確定表に一致させる。`docs.document.get` や `finance.transaction.read` のような別名を YAML に書かない。
- `sa-seed` に付与するのは Firestore の `roles/datastore.user` と config バケットの `roles/storage.objectViewer` の2件だけ。他の SA に上記7コレクションへの書き込み権限を与えない。Catalog を書き換える HTTP API を作らない。

**完了条件**
- [~] `gcloud run jobs execute seed --wait` が exit code 0 で完了し、`catalog_connectors` が2件、`catalog_tools` が7件になる（既定変数のとき）（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `terraform destroy && terraform apply && gcloud run jobs execute seed --wait` の後、`scripts/diff-catalog.sh` の出力が0行（デプロイ後に `scripts/diff-catalog.sh` を実行して観測する）
- [~] `platform-endpoints.json` の `resource_docs_as_issuer` を変えて再 apply と再 seed を行うと、`catalog_connectors/internal-docs-api.authorization_audience` が新しい値に追従する（デプロイ後に `Makefile` の demo-apply と seed 段が観測する）
- [x] `provisioner` として `catalog_tools` へ書き込むと `packages/gcp/src/firestore-guard.ts` が `FirestoreGuardError` を投げ、書き込みが `seed` 以外から成立しない
- [x] プレースホルダを1つ未定義にした YAML で Job が exit code 1 で終了し、標準エラーに未解決のプレースホルダ名が出る（実体は `apps/seed/test/no-partial-write.spec.ts`）

---

### T-IAC-27 seed 入力の構造検証を実装する

**概要**
Connector と Tool の YAML が壊れたまま投入されると、実行時に原因の分かりにくい失敗になる。
投入前にスキーマと相互参照を検証し、違反があれば投入せず非ゼロ終了する。
REQ-04-004、REQ-04-009、REQ-04-010 に対応する。

**対象要件** REQ-04-004, REQ-04-009, REQ-04-010
**前提タスク** T-IAC-26
**成果物** `apps/seed/src/validate.ts`, `packages/xaa-contracts/schema/connector.schema.json`, `packages/xaa-contracts/schema/tool.schema.json`, `apps/seed/test/validate.spec.ts`

**実装方針**
- 検証は Ajv（`strict: true`、`additionalProperties: false`）で行う。型は json-schema-to-ts で導出する。手書きの型定義を置かない。
- Connector の必須は `connector_id` `resource_type` `tools`。`resource_type` は `enum: ["native_xaa", "oauth_bridge"]` の2値に限る。`native_xaa` は `authorization.audience` と `authorization.resource` を必須、`oauth_bridge` は `bridge.audience` を必須にする。この分岐は JSON Schema の `if` / `then` で書く。
- Tool の必須は `tool_id` `description` `required_capability` `authorization.type` `authorization.audience` `authorization.resource` `authorization.scope` `api.base_url` `api.method` `api.path` `risk_level`。`api.method` は `enum: ["GET","POST","PUT","PATCH","DELETE"]`。`authorization.type = "xaa_bridge"` のとき `token.provider` を必須にする。
- スキーマだけで表せない4件をコードで検査する。(1) `connector.tools[]` の全 `tool_id` が tool YAML に実在する。(2) `tool.api.path` 内の `{name}` がすべて `parameters` に定義されている。(3) `tool.required_capability` が `capabilities.yaml` に存在する。(4) `tool.connector_id` が connector YAML に実在する。
- 検証順序を スキーマ → 相互参照 → 投入 に固定する。1件でも違反があれば Firestore へ1件も書かずに exit code 1 で終了する。部分投入を行わない。
- 標準エラーには `ファイルパス / 対象 ID / 違反の種類 / 欠落または不正なフィールド名` の4項目を1行で出す。
- Capability ID の命名規約検査はここで実装しない。`packages/xaa-contracts` の定数表と検査関数（T-AUTHZ-06）を import して呼ぶ。

**完了条件**
- [x] `apps/seed/test/validate.spec.ts::rejects native_xaa connector without authorization.resource` が green
- [x] `apps/seed/test/validate.spec.ts::rejects unknown resource_type` が green
- [x] `apps/seed/test/validate.spec.ts::rejects api.method FETCH` が green
- [x] `apps/seed/test/validate.spec.ts::rejects path placeholder missing from parameters` が green
- [x] 違反を含む YAML で Job を実行すると exit code 1 になり、Firestore の `catalog_tools` の件数が実行前と変わらない（実体は `apps/seed/test/no-partial-write.spec.ts`）

---

### T-IAC-28 agent-activity-stream トピックと push subscription を作る

**概要**
人間向けタイムラインのイベントを流す Pub/Sub 経路を作る。
Security Detection 用のログ経路とは別トピックにし、publish 権限をトピック単位で付与する。
REQ-08-024、REQ-08-025、REQ-11-004 に対応する。

**対象要件** REQ-08-024, REQ-08-025, REQ-11-004
**前提タスク** T-IAC-15
**成果物** `infra/envs/demo/pubsub-activity.tf`, `infra/modules/pubsub-push/main.tf`, `infra/modules/pubsub-push/variables.tf`, `infra/tests/activity-topic.sh`

**実装方針**
- `google_pubsub_topic "agent_activity_stream"` を `name = "agent-activity-stream"` で作る。
- `pubsub-push` モジュールの入力は `topic`、`subscription_name`、`push_endpoint`、`oidc_service_account`、`audience`、`ack_deadline_seconds`、`message_retention_duration`。出力は `subscription_name`。
- subscription は `activity-to-automation-app` の1本だけ。`push_config.push_endpoint` を `${local.run_url["automation-app"]}/internal/activity`、`oidc_token.service_account_email` を `sa-pubsub-push`、`oidc_token.audience` を `local.run_url["automation-app"]` にする。`ack_deadline_seconds = 60`、`message_retention_duration = "600s"`、dead letter policy なし。
- `roles/pubsub.publisher` をトピック単位で付与する対象を、`sa-automation-app` `sa-authorization` `sa-provisioner` `sa-lifecycle` `sa-shared-agent-op` `sa-op-<short>` `sa-agent-runtime` `sa-agent-<short>` `sa-security` `sa-google-bridge` の10系統に固定する。`sa-google-bridge` を含める理由（Consent 完了イベント）をコメント1行で書く。
- `roles/pubsub.subscriber` は `sa-automation-app` にだけ付与する。
- `google_project_iam_member` で `roles/pubsub.publisher` を誰にも付与しない。
- `infra/tests/activity-topic.sh` は plan JSON を走査し、トピックが1つ、push subscription が1つ、publisher の member 集合が上記10系統と完全一致、subscriber が1件であることを検査する。

**完了条件**
- [x] `bash infra/tests/activity-topic.sh` が exit code 0 を返す
- [~] `gcloud pubsub topics get-iam-policy agent-activity-stream --format='value(bindings.members)' | tr ',' '\n' | wc -l` が `max_full_isolation_agents` を含めた件数と一致する（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `gcloud projects get-iam-policy <project_id> --flatten=bindings --format='value(bindings.role)' | grep pubsub.publisher` が0件（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [x] Provisioner が publish した1件のイベントが `users/{human_subject}/activity` 配下に現れる e2e が green（実体は `e2e/test/activity/provisioning-event.spec.ts`）

---

### T-IAC-29 human-permission-changed トピックと push subscription を作る

**概要**
人間の権限変更を Authorization Platform へ通知する Pub/Sub 経路を作る。
push の認証を OIDC トークンで行い、受け側が発信元を検証できるようにする。
REQ-08-023 に対応する。

**対象要件** REQ-08-023
**前提タスク** T-IAC-28
**成果物** `infra/envs/demo/pubsub-permission.tf`

**実装方針**
- `google_pubsub_topic "human_permission_changed"` を `name = "human-permission-changed"` で作る。
- `pubsub-push` モジュールで subscription `permission-to-authorization` を作る。`push_endpoint` は `${local.run_url["authorization"]}/internal/permission-changed`、`oidc_token.service_account_email` は `sa-pubsub-push`、`audience` は `local.run_url["authorization"]`。`ack_deadline_seconds = 60`、`message_retention_duration = "600s"`、dead letter policy なし。
- `sa-pubsub-push` に `authorization` サービスの `roles/run.invoker` を付与する。付与は T-IAC-15 の `invoker_edges` 側に書き、ここでは書かない。
- publish 権限は `sa-automation-app` にだけ付与する。権限変更の起点は `pnpm perm:set` スクリプトが Automation App の API を経由する形にし、CLI から直接 publish させない。
- 受信側の ID Token 検証（`iss` が `https://accounts.google.com`、`aud` が自サービス URL、`email` が `sa-pubsub-push`）はアプリ側の責務とする。Terraform では検証しない。

**完了条件**
- [~] `gcloud pubsub topics publish human-permission-changed --message '{"human_subject":"user-456"}'` の後、`authorization` のログに受信が記録される（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [x] Authorization ヘッダを外した同一 POST が Cloud Run の run.invoker により 403 を返す
- [~] `gcloud pubsub subscriptions describe permission-to-authorization --format='value(pushConfig.oidcToken.serviceAccountEmail)'` が `sa-pubsub-push@` で始まる値を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `gcloud pubsub topics get-iam-policy human-permission-changed --format='value(bindings.members)'` に `sa-automation-app` 以外の publisher が現れない（デプロイ後に `infra/tests/verify-all.sh` が観測する）

---

### T-IAC-30 Cloud Logging から Security Detection への一方向経路を作る

**概要**
アプリの構造化ログを Cloud Logging へ集め、Log Sink で Pub/Sub へ流し、Security Detection へ push する。
Security Detection が書き戻す経路とアプリが直接書く経路を作らない。
REQ-08-027 に対応する。

**対象要件** REQ-08-027
**前提タスク** T-IAC-29
**成果物** `infra/envs/demo/logging-security.tf`

**実装方針**
- `google_pubsub_topic "security_logs"` を `name = "security-logs"` で作る。
- `google_logging_project_sink "security_log_sink"` を作る。`destination` は当該トピック、`filter` は `resource.type="cloud_run_revision" OR resource.type="cloud_run_job"`、`unique_writer_identity = true`。
- sink の `writer_identity` にトピックの `roles/pubsub.publisher` を `google_pubsub_topic_iam_member` で付与する。他の SA にこのトピックの publisher を与えない。
- `pubsub-push` モジュールで subscription `security-logs-to-detection` を作る。`push_endpoint` は `${local.run_url["security-detection"]}/internal/log`、OIDC は `sa-pubsub-push`、`audience` は `local.run_url["security-detection"]`。
- `sa-security` にこの subscription の `roles/pubsub.subscriber` を付与する。
- Security Detection から Cloud Logging へ書き戻す経路と、アプリから BigQuery へ直接書く経路を作らない。`roles/bigquery.dataEditor` をアプリの SA に付与しない。
- Activity Event 用のログがこの sink のフィルタに入らないよう、Activity Event は Cloud Logging へ出さず Pub/Sub へ直接 publish する方針をコメント1行で書く。

**完了条件**
- [~] `gcloud logging sinks describe security-log-sink --format='value(destination)'` が `pubsub.googleapis.com/projects/<project_id>/topics/security-logs` を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] 任意アプリが出力した ERROR ログが3分以内に `security-detection` のログへ到達する e2e が green（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）
- [~] `gcloud pubsub topics get-iam-policy security-logs --format='value(bindings.members)'` の publisher が sink の writer identity 1件のみ（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `terraform plan -json` に `sa-security` を member とする `roles/logging.*` が現れない（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）

---

### T-IAC-31 BigQuery 監査 dataset と Log Sink を shared state に作る

**概要**
監査ログの保存先を同一プロジェクト内の BigQuery dataset に置き、書き込みを Log Sink の writer identity だけに限る。
dataset の IAM を authoritative なリソースで管理し、後から member が増えないようにする。
REQ-08-002、REQ-09-018、DEC-IAC-03、DEC-IAC-11 に対応する。

**対象要件** REQ-08-002, REQ-09-018
**前提タスク** T-IAC-04
**成果物** `infra/envs/shared/audit.tf`, `infra/envs/shared/outputs.tf`, `infra/tests/one-way-sink.sh`

**実装方針**
- dataset 名を `security_audit` に確定する。REQ-08-002 の `agent_security_audit` と REQ-07-035 の `agent_security` という名前の dataset を作らない。
- `google_bigquery_dataset "security_audit"` を `location = var.region`、`default_table_expiration_ms = 604800000`（7日）、`delete_contents_on_destroy = true` で作る。
- `google_logging_project_sink "audit_bq_sink"` を `destination = "bigquery.googleapis.com/projects/${var.project_id}/datasets/security_audit"`、`unique_writer_identity = true`、`bigquery_options { use_partitioned_tables = true }` で作る。
- dataset の IAM を `google_bigquery_dataset_iam_binding` で管理する。`roles/bigquery.dataEditor` の members を sink の `writer_identity` の1件だけにする。`google_bigquery_dataset_iam_member` を併用しない。
- REQ-09-018 が求める `sa-log-sink` という名前の Service Account を別途作らない。`unique_writer_identity` が生成する writer identity をその役割に充てる。この読み替えを `audit.tf` のコメントに1行書く。
- `google_project_iam_member` で `roles/bigquery.*` を誰にも付与しない。
- `infra/tests/one-way-sink.sh` は plan JSON を走査し、`security_audit` への書き込みロールを持つ member が1件だけであること、プロジェクトレベルの bigquery ロールが0件であることを検査する。

**完了条件**
- [x] `bash infra/tests/one-way-sink.sh` が exit code 0 を返す
- [~] 任意の Cloud Run アプリが出力した1件のログが5分以内に `security_audit` 内のテーブルへ現れる（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）
- [~] `bq show --format=prettyjson <project_id>:security_audit | jq '[.access[] | select(.role=="WRITER")] | length'` が1を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `terraform apply` の後 `terraform plan -detailed-exitcode` が exit code 0 を返す（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）

---

### T-IAC-32 Lifecycle の監査レコード用テーブルと追記権限を作る

**概要**
Agent の Cleanup 後に残す監査情報の保存先を BigQuery に用意する。
`sa-lifecycle` には追記だけを許し、テーブルと dataset の削除を許さない。
REQ-07-035 に対応する。

**対象要件** REQ-07-035
**前提タスク** T-IAC-31
**成果物** `infra/envs/shared/audit-table.tf`, `infra/schema/agent-lifecycle-audit.json`, `infra/tests/audit-iam.sh`

**実装方針**
- `google_bigquery_table "agent_lifecycle_audit"` を dataset `security_audit` の中に作る。`deletion_protection = false`、`time_partitioning { type = "DAY", field = "destroyed_at" }`。
- スキーマは `infra/schema/agent-lifecycle-audit.json` に置き、列を10件に固定する。`agent_id` `human_subject` `created_at` `expires_at` `destroyed_at` `isolation_level` `effective_capabilities`（REPEATED STRING）`allowed_tools`（REPEATED STRING）`cleanup_step_results`（REPEATED RECORD）`termination_reason`。11件目の列を足さない。
- Raw Token、Refresh Token、鍵素材に相当する列を作らない。
- `sa-lifecycle` にはテーブル単位の `google_bigquery_table_iam_member` で `roles/bigquery.dataEditor` を付与する。dataset 単位の `roles/bigquery.dataOwner` と `roles/bigquery.admin` を付与しない。
- dataset の authoritative binding（T-IAC-31）と競合しないよう、`sa-lifecycle` の付与はテーブル単位に限る。この理由をコメント1行で書く。
- `sa-security` には dataset 単位の `roles/bigquery.dataViewer` とプロジェクト単位の `roles/bigquery.jobUser` を付与する。削除を含むカスタムロールを作らない。
- `infra/tests/audit-iam.sh` は plan JSON を走査し、platform 側 SA が `security_audit` に対して `dataOwner` `admin` `datasets.delete` を含むロールを持たないことを検査する。

**完了条件**
- [x] `bash infra/tests/audit-iam.sh` が exit code 0 を返す
- [~] `bq show --schema <project_id>:security_audit.agent_lifecycle_audit | jq 'length'` が10を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `sa-lifecycle` の資格情報で `bq rm -f <project_id>:security_audit.agent_lifecycle_audit` が PERMISSION_DENIED になる（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `sa-lifecycle` の資格情報で同テーブルへの1行 insert が成功する（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）

---

### T-IAC-33 Cloud Scheduler から Lifecycle Manager を定期起動する

**概要**
期限到達 Agent の Cleanup と、実行時に作った GCP リソースの掃除を、Cloud Scheduler が定期的に叩く形で駆動する。
呼び出しは OIDC トークンで認証し、専用 SA を使う。
REQ-08-026 に対応する。

**対象要件** REQ-08-026
**前提タスク** T-IAC-15
**成果物** `infra/envs/demo/scheduler.tf`, `infra/envs/demo/variables-scheduler.tf`

**実装方針**
- 変数 `lifecycle_tick_cron`（string、既定 `*/5 * * * *`）を定義する。
- `google_cloud_scheduler_job "lifecycle_tick"` を `schedule = var.lifecycle_tick_cron`、`time_zone = "Etc/UTC"`、`attempt_deadline = "60s"`、`retry_config { retry_count = 0 }` で作る。
- `http_target` は `uri = "${local.run_url["lifecycle"]}/internal/tick"`、`http_method = "POST"`、`oidc_token { service_account_email = <sa-scheduler>, audience = local.run_url["lifecycle"] }`。
- `sa-scheduler` に付与するのは `lifecycle` の `roles/run.invoker` だけ。付与は T-IAC-15 の `invoker_edges` に書く。
- Scheduler Job を複数作らない。tick は1本に集約し、Lifecycle Manager 側で処理を分岐する。
- `agent_max_lifetime_seconds` を検証プロファイルで 3600 に下げたとき、5分間隔の tick で期限判定が間に合うことを前提とする。この関係を `scheduler.tf` のコメント1行で書く。

**完了条件**
- [~] `gcloud scheduler jobs describe lifecycle-tick --location <region> --format='value(schedule)'` が `lifecycle_tick_cron` と一致する（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `gcloud scheduler jobs run lifecycle-tick --location <region>` の後、`lifecycle` のログに tick 受信が記録される（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `gcloud scheduler jobs describe lifecycle-tick --format='value(retryConfig.retryCount)'` が 0 を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] 認証なしの `curl -X POST <lifecycle URL>/internal/tick` が 403 を返す（デプロイ後に `infra/tests/reachability.sh` が観測する）

---

### T-IAC-34 Artifact Registry とイメージ供給の経路を作る

**概要**
Cloud Run が参照するコンテナイメージの置き場を作る。
ビルドと push は Terraform 管理外にし、Terraform には `image_tag` だけを渡す。
REQ-08-050 と DEC-IAC-18 に対応する。

**対象要件** REQ-08-050
**前提タスク** T-IAC-04
**成果物** `infra/envs/shared/artifact-registry.tf`, `infra/envs/shared/outputs.tf`, `Dockerfile`, `scripts/build-push.sh`

**実装方針**
- `google_artifact_registry_repository "xaa"` を `repository_id = "xaa"`、`format = "DOCKER"`、`location = var.region`、`cleanup_policies` で最新3タグのみ保持する設定にする。
- `google_cloudbuild_trigger` と `google_cloudbuild_*` を1つも書かない。Cloud Build を使わない。
- `Dockerfile` はリポジトリ直下の1本にし、`--build-arg APP=<name>` でビルド対象を切り替える multi-stage 構成にする。実行段は distroless を使う。
- `scripts/build-push.sh` は引数でアプリ名の配列を受け、`docker build --build-arg APP=<name> -t <registry>/<project>/xaa/<name>:<tag>` と `docker push` を順に実行する。タグは引数 `--tag` 必須とし、既定値を持たせない。
- shared の outputs に `registry_host`（`<region>-docker.pkg.dev`）と `repository_path` を出す。demo はこれを `terraform_remote_state` から受け取る。
- Cloud Run の SA に `roles/artifactregistry.reader` を付与する。Cloud Run のサービスエージェントが既定で持つ権限に依存しない。

**完了条件**
- [~] `gcloud artifacts repositories describe xaa --location <region> --format='value(format)'` が `DOCKER` を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `bash scripts/build-push.sh --tag v1 human-idp` の後、`gcloud artifacts docker images list <registry>/<project>/xaa/human-idp` に `v1` が現れる（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `-var image_tag=v1` での2回目の apply で Cloud Run のリビジョンが更新される（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）
- [x] `grep -rn 'google_cloudbuild' infra/` が0件

---

### T-IAC-35 Control Plane の SA 権限を定義する

**概要**
Automation App と Authorization Platform に必要な権限だけを付与し、KMS と Secret Manager と Connector 系のデータへ届かないようにする。
REQ-08-046 に対応する。

**対象要件** REQ-08-046
**前提タスク** T-IAC-25, T-IAC-28
**成果物** `infra/envs/demo/iam-controlplane.tf`

**実装方針**
- `sa-automation-app` に付与するのは、`authorization` と `provisioner` と `lifecycle` への `roles/run.invoker`（T-IAC-15 側）、`roles/aiplatform.user`、Firestore の `roles/datastore.user`、`agent-activity-stream` の publisher と subscriber、config バケットの `roles/storage.objectViewer` の6種。
- `sa-authorization` に付与するのは、`lifecycle` への `roles/run.invoker`（T-IAC-15 側）、`roles/aiplatform.user`、Firestore の `roles/datastore.user`、`agent-activity-stream` の publisher、config バケットの `objectViewer` の5種。
- 両 SA に KMS の権限、Secret Manager の権限、JWKS バケットの書き込み権限を付与しない。
- Firestore は IAM ではコレクションを分けられないため、`idp_connections` と `connector_bindings` への到達禁止は T-IAC-25 の許可マトリクスで担保する。この点をコメントに DEV-05 を引いて書く。
- `sa-authorization` の Cloud Run 環境変数に `api_base_url` や外部ホスト名に相当するキーを注入しない。Tool の接続情報を Authorization Platform に持たせない（REQ-03-020）。

**完了条件**
- [x] `sa-automation-app` の資格情報で `shared-agent-op-idjag` の asymmetricSign が PERMISSION_DENIED になる
- [x] `sa-automation-app` の資格情報で `google-oauth-client-secret` の読み取りが PERMISSION_DENIED になる
- [x] `packages/gcp/test/firestore-guard.spec.ts::authorization cannot read idp_connections` が green
- [~] `gcloud run services describe authorization --format='value(spec.template.spec.containers[0].env)' | grep -cE 'base_url|googleapis\.com'` が0を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）

---

### T-IAC-36 Identity と Runtime と Security の SA 権限を定義する

**概要**
Agent OP と Agent Runtime と Security Detection の SA に、それぞれの役割に必要な権限だけを付与する。
Runtime に KMS と Secret Manager の権限を与えない。
REQ-08-047 に対応する。

**対象要件** REQ-08-047
**前提タスク** T-IAC-35
**成果物** `infra/envs/demo/iam-identity.tf`, `infra/envs/demo/iam-runtime.tf`, `infra/envs/demo/iam-security.tf`

**実装方針**
- `sa-shared-agent-op` に付与するのは、`shared-agent-op-idjag` の signerVerifier、`idp-connection` の cryptoKeyEncrypterDecrypter、Firestore の `roles/datastore.user`、JWKS バケットの prefix 条件付き `objectCreator`、`agent-activity-stream` の publisher、config バケットの `objectViewer` の6種。
- `sa-human-idp` に付与するのは、`human-idp-sso-wrap` の cryptoKeyEncrypterDecrypter、Firestore の `datastore.user`、JWKS バケットの prefix 条件付き `objectCreator`、config バケットの `objectViewer` の4種。
- `sa-resource-docs-as` と `sa-resource-finance-as` に付与するのは、それぞれの `*-wrap` 鍵の cryptoKeyEncrypterDecrypter、JWKS バケットの prefix 条件付き `objectCreator`、config バケットの `objectViewer` の3種。`datastore.user` を AS には与えない。
- `sa-resource-docs-api` と `sa-resource-finance-api` に付与するのは Firestore の `datastore.user` と config バケットの `objectViewer` の2種。
- `sa-agent-runtime` に付与するのは、T-IAC-15 の `run.invoker`、`roles/aiplatform.user`、Firestore の `datastore.user`、`agent-activity-stream` の publisher、config バケットの `objectViewer` の5種。KMS、Secret Manager、JWKS バケットの書き込み権限を与えない。
- `sa-security` に付与するのは、`security-logs-to-detection` の `roles/pubsub.subscriber`、`security_audit` dataset の `roles/bigquery.dataViewer`、プロジェクトの `roles/bigquery.jobUser`、`roles/aiplatform.user`、`lifecycle` への `run.invoker`、`agent-activity-stream` の publisher の6種。

**完了条件**
- [x] `sa-agent-runtime` の資格情報で KMS 署名、Secret Manager 読み取り、JWKS オブジェクトの書き込みの3件がすべて PERMISSION_DENIED になる
- [x] `sa-security` の資格情報で `security_audit` への insert が PERMISSION_DENIED になる
- [x] `sa-resource-docs-as` の資格情報で `resource-finance-as-wrap` の decrypt が PERMISSION_DENIED になる
- [x] `sa-shared-agent-op` の資格情報で `keys/op-shared-1.json` の作成が成功する

---

### T-IAC-37 Provisioner と Lifecycle の作成権限を名前空間で絞る

**概要**
Provisioner と Lifecycle は Dedicated OP 一式を実行時に作り消すため、作成系のロールが要る（DEC-IAC-07、DEC-IAC-08）。
Project 内で最も強い2つの SA になるので、与える範囲をリソース種別と名前の接頭辞で絞り、Terraform 管理のリソースへ手が届かないようにする。
REQ-08-009、REQ-08-011 に対応する。

**対象要件** REQ-08-009, REQ-08-011
**前提タスク** T-IAC-36
**成果物** `infra/envs/demo/iam-provisioner.tf`, `infra/envs/demo/iam-lifecycle.tf`, `infra/envs/demo/custom-roles.tf`, `infra/tests/forbidden-roles.sh`（追記）

**実装方針**
- `sa-provisioner` に付与するのは9種とする。
  `shared-agent-op` と `google-bridge` と `agent-op-callback` への `run.invoker`（T-IAC-15 側）。
  `agent-runtime-standard` への `roles/run.jobsExecutorWithOverrides`。
  Cloud Run Service と Job を作るためのカスタムロール `dedicated_op_creator`。
  Service Account を作るためのカスタムロール `dedicated_sa_creator`。
  `idjag-signing` と `idp-connection-encryption` の各 Key Ring への `roles/cloudkms.admin`。
  Firestore の `datastore.user`。
  `agent-activity-stream` の publisher。
  config バケットの `objectViewer`。
- `sa-lifecycle` に付与するのは8種とする。
  `agent-runtime-standard` への `roles/run.jobsExecutorWithOverrides`。
  Execution 取り消し用のカスタムロール `run_execution_canceller`。
  Cloud Run Service と Job と Service Account を消すためのカスタムロール `dedicated_op_destroyer`。
  `idjag-signing` と `idp-connection-encryption` の各 Key Ring への `roles/cloudkms.admin`。
  T-IAC-15 の `run.invoker` 群。
  Firestore の `datastore.user`。
  `agent-activity-stream` の publisher。
  `agent_lifecycle_audit` テーブルの `dataEditor`。
- カスタムロールを4つ作り、`permissions` を最小にする。
  `run_execution_canceller` は `run.executions.cancel` と `run.executions.get` の2件。
  `dedicated_op_creator` は `run.services.create` と `run.services.get` と `run.services.setIamPolicy` と `run.jobs.create` と `run.jobs.get` の5件。
  `dedicated_sa_creator` は `iam.serviceAccounts.create` と `iam.serviceAccounts.get` と `iam.serviceAccounts.actAs` の3件。
  `dedicated_op_destroyer` は `run.services.delete` と `run.jobs.delete` と `iam.serviceAccounts.delete` と `run.services.get` と `run.jobs.get` と `iam.serviceAccounts.get` の6件。
  `roles/run.admin` と `roles/iam.serviceAccountAdmin` と `roles/editor` を使わない。
- 両 SA に `roles/resourcemanager.projectIamAdmin` と `roles/secretmanager.*` と `roles/owner` を付与しない。
- `sa-provisioner` と `sa-lifecycle` に `roles/cloudkms.signerVerifier` を付与しない。
  鍵の作成と鍵バージョンの操作だけを許し、署名を許さない。
  `roles/cloudkms.admin` は署名権限を含まないため、この2つは両立する。
- 名前の接頭辞による境界は IAM では表現できない。
  Terraform 管理のリソースを実行時に変更しないことは、T-PROV-24 と T-LIFE-09 の実装側（触れてよい接頭辞6種のガード）と `infra/tests/runtime-mutation-scope.sh` で担保する。
  この分担を `iam-provisioner.tf` のコメントに書く。
- `infra/tests/forbidden-roles.sh` に、両 SA が `roles/owner` と `roles/editor` と `roles/run.admin` と `roles/iam.serviceAccountAdmin` と `roles/resourcemanager.projectIamAdmin` を持たないことの検査を追記する。

**完了条件**
- [~] `gcloud iam roles list --project <project_id> --format='value(name)'` が上記4つのカスタムロールを含む（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `gcloud iam roles describe dedicated_op_creator --project <project_id> --format='value(includedPermissions)'` が5件を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `gcloud iam roles describe dedicated_op_destroyer --project <project_id> --format='value(includedPermissions)'` が6件を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [x] `sa-provisioner` の資格情報で `google-oauth-client-secret` の読み取りが PERMISSION_DENIED になる
- [x] `sa-provisioner` の資格情報で `idjag-signing` Key Ring 内の鍵に対する asymmetricSign が PERMISSION_DENIED になる
- [~] `sa-lifecycle` の資格情報で `gcloud run services delete human-idp` が PERMISSION_DENIED にならない代わりに、`infra/tests/runtime-mutation-scope.sh` がコード側でこの呼び出しが書けないことを検査して終了コード0を返す
- [~] `bash infra/tests/forbidden-roles.sh` が終了コード0で通る（デプロイ後に `infra/tests/forbidden-roles.sh` が観測する）

---

### T-IAC-38 Google Bridge の到達範囲を3リソースに限定する

**概要**
Bridge は外部 SaaS の資格情報を扱うため、到達できる範囲を明示的に狭める。
Secret と Connector 暗号鍵と Connector のデータ以外へ届かないようにする。
REQ-08-054 に対応する。

**対象要件** REQ-08-054
**前提タスク** T-IAC-37
**成果物** `infra/envs/demo/iam-bridge.tf`

**実装方針**
- `sa-google-bridge` に付与するのは、`google-oauth-client-secret` の `roles/secretmanager.secretAccessor`、`google-connector` 鍵の `roles/cloudkms.cryptoKeyEncrypterDecrypter`、Firestore の `roles/datastore.user`、`agent-activity-stream` の publisher、config バケットの `objectViewer` の5種。
- Firestore への到達は IAM では `connector_bindings/**` に絞れないため、T-IAC-25 の許可マトリクスで `connector_bindings` のみに限定する。この読み替えをコメントに DEV-05 を引いて書く。
- `idjag-signing` の鍵、`idp-connection` の鍵、JWKS バケットの書き込み権限、Cloud Run Job の実行権限を付与しない。
- これらの IAM は `enable_google_bridge` が false のとき `count = 0` で作らない。SA 自体は台帳に残すが権限を持たない状態にする。

**完了条件**
- [x] `sa-google-bridge` の資格情報で `shared-agent-op-idjag` の asymmetricSign が PERMISSION_DENIED になる
- [x] `sa-google-bridge` の資格情報で `idp-connection` 鍵の decrypt が PERMISSION_DENIED になる
- [~] `sa-google-bridge` の資格情報で `google-oauth-client-secret` の読み取りと `google-connector` 鍵の encrypt が成功する（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）
- [x] `packages/gcp/test/firestore-guard.spec.ts::bridge cannot read agent_registrations` が green

---

### T-IAC-39 Vertex AI の利用 SA とモデル変数を定義する

**概要**
推論を行う5系統の SA にだけ `roles/aiplatform.user` を付与し、モデル名を変数から注入する。
アプリにモデル名をハードコードさせない。
REQ-08-049 と DEC-APP-10 に対応する。

**対象要件** REQ-08-049
**前提タスク** T-IAC-36
**成果物** `infra/envs/demo/iam-vertex.tf`, `infra/envs/demo/variables-vertex.tf`, `infra/tests/vertex-scope.sh`

**実装方針**
- 変数 `vertex_model`（string、既定 `gemini-2.5-flash`）と `vertex_location`（string、既定 `us-central1`）を定義する。
- `roles/aiplatform.user` を付与するのは `sa-automation-app` `sa-authorization` `sa-agent-runtime` `sa-agent-<short>` `sa-security` の5系統だけ。`google_project_iam_member` で付与する（Vertex AI はリソース単位の付与ができないため）。
- `sa-provisioner` `sa-lifecycle` `sa-shared-agent-op` `sa-op-<short>` `sa-google-bridge` `sa-resource-*` `sa-human-idp` `sa-seed` `sa-jwks-publish` `sa-stub-saas-op` に付与しない。
- 5系統の Cloud Run Service と Job に `VERTEX_MODEL` と `VERTEX_LOCATION` と `VERTEX_MODE`（既定 `live`）を環境変数で注入する。
- `infra/tests/vertex-scope.sh` は plan JSON を走査し、`roles/aiplatform.user` の member 集合が上記5系統と完全一致することを検査する。さらに `grep -rnE 'gemini-[0-9]' apps/ packages/` が0件であることを確認する。

**完了条件**
- [x] `bash infra/tests/vertex-scope.sh` が exit code 0 を返す
- [x] `sa-provisioner` の資格情報で Vertex AI の `generateContent` が PERMISSION_DENIED になる
- [x] `grep -rnE 'gemini-[0-9]' apps/*/src packages/*/src` が0件
- [~] 4系統のアプリのログに同一の `VERTEX_MODEL` 値が現れる（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）

---

### T-IAC-40 reachability 検査スクリプトを作る

**概要**
IAM の定義どおりに呼べるか、定義外は 403 になるかを apply 直後に実測する。
plan の静的検査だけでは ingress と IAM の組み合わせの誤りを検出できない。
DEC-IAC-15 と DEC-IAC-19 に対応する。

**対象要件** REQ-08-021, REQ-05-012
**前提タスク** T-IAC-16
**成果物** `infra/tests/reachability.sh`, `infra/tests/reachability-cases.json`

**実装方針**
- `reachability-cases.json` を `[{ "caller_sa": ..., "target": ..., "path": "/livez", "expect": 200 or 403 }]` の配列にする。許可エッジは `terraform output -json invoker_edges` から生成し、拒否ケースは手書きで最低6件を固定する。
- 拒否ケースに必ず含めるのは、`sa-automation-app` → `shared-agent-op`、`sa-agent-runtime` → `authorization`、`sa-agent-runtime` → `dedicated-op-aaaaaaaaaaaa`、`sa-agent-aaaaaaaaaaaa` → `shared-agent-op`、`sa-agent-aaaaaaaaaaaa` → `dedicated-op-bbbbbbbbbbbb`、認証なし → `authorization` の6件。
- 呼び出しは `gcloud auth print-identity-token --impersonate-service-account=<sa> --audiences=<url>` で ID Token を取り、`curl -o /dev/null -w '%{http_code}'` で status code だけを見る。レスポンス本文を評価しない。
- 実行者に `roles/iam.serviceAccountTokenCreator` が必要な点を、スクリプトの冒頭コメントと `infra/README.md` に書く。権限が無い場合は前提不足として exit code 2 で終了し、テスト失敗（exit 1）と区別する。
- 失敗時は `caller / target / expected / actual` の4項目を1行で出し、全ケースを実行してから最後に非ゼロ終了する。最初の失敗で止めない。

**完了条件**
- [~] `bash infra/tests/reachability.sh` が apply 直後に exit code 0 を返す（デプロイ後に `infra/tests/reachability.sh` が観測する）
- [~] 拒否ケースが6件以上あり、そのすべてで実測が 403 になる（デプロイ後に `infra/tests/reachability.sh` が観測する）
- [~] `invoker_edges` から1エッジを削除して apply したブランチで、対応する許可ケースが失敗し exit code 1 になる（デプロイ後に `infra/tests/reachability.sh` が観測する）
- [x] 権限不足の実行者で走らせると exit code 2 になり、標準エラーに必要ロール名が出る

---

### T-IAC-41 forbidden-roles 検査スクリプトを作る

**概要**
Platform 側の SA が監査ログを消せる権限や広すぎる権限を持っていないことを機械的に確認する。
単一プロジェクト構成では、プロジェクト分離の代わりにこの検査が保護の実体になる。
REQ-08-003、REQ-09-019、DEC-IAC-08、DEC-IAC-11 に対応する。

**対象要件** REQ-08-003, REQ-09-019
**前提タスク** T-IAC-32
**成果物** `infra/tests/forbidden-roles.sh`, `infra/tests/forbidden-roles.json`, `infra/envs/shared/deny-policy.tf`, `infra/envs/shared/variables-deny.tf`

**実装方針**
- 禁止ロール集合を `forbidden-roles.json` に置く。`roles/owner` `roles/editor` `roles/bigquery.dataOwner` `roles/bigquery.admin` `roles/logging.admin` `roles/logging.configWriter` `roles/run.admin` `roles/iam.serviceAccountAdmin` `roles/resourcemanager.projectIamAdmin` `roles/cloudkms.admin`（`idjag-signing` の鍵に対する `sa-lifecycle` の付与のみ例外）の10件。
- 検査対象 SA は `sa-` で始まる全 SA。台帳を読まず、`gcloud iam service-accounts list` の結果から動的に集める。新しい SA を足しても検査が自動で追随する。
- 検査対象は3か所。プロジェクト IAM ポリシー、`security_audit` dataset の IAM、各 KMS CryptoKey の IAM。この3か所を集約して禁止集合との交差を判定する。
- 例外は `forbidden-roles.json` の `exceptions` 配列に `{ "member": ..., "role": ..., "resource": ..., "reason": ... }` の4項目で明記する。`reason` が空の例外行を許さない。
- `enable_deny_policy`（bool、既定 false）が true のとき `google_iam_deny_policy` を作り、platform 側 SA に対して `bigquery.tables.delete` `bigquery.tables.deleteData` `bigquery.datasets.delete` `logging.sinks.delete` を拒否する。spike の結果（T-IAC-01 の (d)）が可なら既定を true に変える。
- 検査は plan ではなく apply 後の実 IAM に対して行う。plan だけでは既存の手動付与を検出できないため。

**完了条件**
- [~] `bash infra/tests/forbidden-roles.sh` が apply 直後に exit code 0 を返す（デプロイ後に `infra/tests/forbidden-roles.sh` が観測する）
- [~] `gcloud projects add-iam-policy-binding <project_id> --member=serviceAccount:sa-provisioner@... --role=roles/editor` を実行した状態で同スクリプトが exit code 1 を返し、標準エラーに SA 名とロール名が出る（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [x] `forbidden-roles.json` の `exceptions` の全行に `reason` が入っている
- [~] `terraform plan -var enable_deny_policy=true` に `google_iam_deny_policy` が1件現れる（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）

---

### T-IAC-42 invoker-matrix 検査スクリプトを作る

**概要**
`invoker_edges` に書いた組み合わせと、実際に付与されている `run.invoker` の組み合わせが一致することを確認する。
定義外のエッジが手動で足されていないことを検出する。
REQ-01-022 と REQ-08-022 に対応する。

**対象要件** REQ-01-022, REQ-08-022
**前提タスク** T-IAC-40
**成果物** `infra/tests/invoker-matrix.sh`

**実装方針**
- `terraform output -json invoker_edges` の期待集合と、全 Cloud Run Service の `gcloud run services get-iam-policy --format=json` から抽出した `roles/run.invoker` の member 集合を突き合わせる。
- 比較は集合の完全一致で行う。期待に無い実測（余分）と、実測に無い期待（不足）の両方を別々に列挙する。
- `allUsers` の付与は `locals.public_services` の期待集合と別途突き合わせる。`invoker_edges` に混ぜない。
- 禁止3組（`sa-agent-runtime` → `dedicated-op-*`、`sa-agent-<short>` → `shared-agent-op`、`sa-agent-<short>` → `dedicated-idjag-<m>` で m ≠ n）を明示的に検査し、1件でも見つかったら他の差分に関わらず exit code 1 にする。
- Cloud Run Job の `run.invoker` は検査対象にしない。Job は invoker ではなく `jobsExecutorWithOverrides` で制御するため。
- 出力は差分表形式（`種別 / caller / target`）で標準エラーへ出す。

**完了条件**
- [~] `bash infra/tests/invoker-matrix.sh` が apply 直後に exit code 0 を返す（デプロイ後に `infra/tests/invoker-matrix.sh` が観測する）
- [~] `gcloud run services add-iam-policy-binding shared-agent-op --member=serviceAccount:sa-agent-aaaaaaaaaaaa@... --role=roles/run.invoker` の後に同スクリプトが exit code 1 を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [x] `allUsers` の比較が `locals.public_services` に対して行われ、`invoker_edges` の件数に含まれていない
- [x] 禁止3組の検査結果が、他の差分と区別できるラベル付きで出力される

---

### T-IAC-43 静的検査スクリプト群を作る

**概要**
実行時に GCP リソースを作らないこと、KMS の鍵バージョンを Terraform で管理しないこと、VPC と Cloud SQL を作らないことを、コードの静的検査で固定する。
これらは apply 後には検出しにくいため、CI で常時走らせる。
DEC-IAC-04、DEC-IAC-09、DEC-IAC-25 に対応する。

**対象要件** REQ-01-010, REQ-05-056, REQ-08-043
**前提タスク** T-IAC-25
**成果物** `infra/tests/runtime-mutation-scope.sh`, `infra/tests/no-kms-key-version.sh`, `infra/tests/static-all.sh`, `.github/workflows/infra-static.yml`

**実装方針**
- `runtime-mutation-scope.sh` は `apps/provisioner/src` と `apps/lifecycle/src` と `apps/agent-runtime/src` を対象に、禁止パターンを grep する。`@google-cloud/run` の `ServicesClient` と `JobsClient` の `create` `delete` `update` `patch`、`@google-cloud/kms` の `createCryptoKey` `createKeyRing`、`google.iam` の `createServiceAccount`、`run.googleapis.com/v2/projects/.*/services` への直接 HTTP 呼び出し。`ExecutionsClient` の `run` と `cancel` は許可する。
- 許可と禁止の境界をスクリプト冒頭のコメントに明記する。Job Execution の起動と取り消しだけが実行時に許される GCP の変更操作である旨を書く。
- `no-kms-key-version.sh` は `grep -rn 'google_kms_crypto_key_version' infra/` が0件であることを検査する。ヒットした場合は DEC-IAC-04 の理由を標準エラーに出す。
- `static-all.sh` は `single-project.sh` `no-cloudsql.sh` `no-firestore-rules.sh` `public-surface.sh` `runtime-mutation-scope.sh` `no-kms-key-version.sh` `kms-iam.sh` `no-dedicated-op-in-tf.sh` `dedicated-iam-shape.sh` を順に実行し、1つでも失敗したら非ゼロ終了する。途中で止めず全件実行してから集計する。
- `.github/workflows/infra-static.yml` は GCP 認証を必要としないこれらの検査だけを走らせる。apply を伴う検査（reachability、forbidden-roles、invoker-matrix）はこのワークフローに入れない。

**完了条件**
- [x] `bash infra/tests/static-all.sh` が exit code 0 を返す
- [x] `apps/provisioner/src` に `new ServicesClient().createService(` を追加したブランチで `runtime-mutation-scope.sh` が exit code 1 を返す
- [x] `infra/envs/shared/kms.tf` に `google_kms_crypto_key_version` を1件足したブランチで `no-kms-key-version.sh` が exit code 1 を返す
- [x] CI ジョブ `infra-static` が GCP 認証情報なしで green

---

### T-IAC-44 秘密情報の非保存とフロントの SDK 混入を CI で検査する

**概要**
データストアへ Raw Token や鍵素材を保存する経路を作らないことと、ブラウザに Firestore SDK を持ち込まないことを、CI で固定する。
Firestore Security Rules を作らない方針の代替統制になる。
REQ-08-040、REQ-08-038、DEV-13 に対応する。

**対象要件** REQ-08-040, REQ-08-038
**前提タスク** T-IAC-43
**成果物** `infra/tests/no-secret-fields.sh`, `infra/tests/no-firestore-sdk-in-frontend.sh`, `scripts/dump-firestore.sh`

**実装方針**
- `no-secret-fields.sh` は `infra/schema/*.json` と `infra/schema/firestore-collections.md` と `packages/xaa-contracts/schema/*.json` を対象に、禁止語 `access_token` `private_key` `client_secret` `id_token` を検出したら exit code 1 にする。`refresh_token` は `refresh_token_ciphertext` と `refresh_token_key_version` の2つだけを許可し、それ以外の形を禁止する。
- `no-firestore-sdk-in-frontend.sh` は `apps/automation-app/src/client` と esbuild のバンドル出力を対象に、`firebase/firestore` `@firebase/` `firebase/auth` `@google-cloud/firestore` の import を検出したら exit code 1 にする。サーバ側コード（`apps/automation-app/src/server`）は対象外にする。
- `scripts/dump-firestore.sh` は e2e 実行後に全コレクションを JSON へ書き出し、`eyJ` で始まる文字列が0件であることを検査する。JWT の平文保存を検出する。
- 検査対象のディレクトリ境界をスクリプト冒頭に列挙する。対象外にした理由を1行ずつ書く。
- これらを `static-all.sh` に追加する。

**完了条件**
- [x] `bash infra/tests/no-secret-fields.sh` が exit code 0 を返す
- [x] `bash infra/tests/no-firestore-sdk-in-frontend.sh` が exit code 0 を返す
- [x] `apps/automation-app/src/client` に `import { getFirestore } from "firebase/firestore"` を足したブランチで後者が exit code 1 を返す（実体は `infra/tests/no-firestore-sdk-in-frontend.sh`）
- [~] e2e 実行後の `bash scripts/dump-firestore.sh` が `eyJ` を0件と報告する（デプロイ後に `scripts/dump-firestore.sh` が観測する）

---

### T-IAC-45 destroy で課金リソースが残らない状態を固定する

**概要**
apply と destroy を繰り返せることを構成で保証する。
destroy 後に残るのは KMS の Key Ring と CryptoKey、および既存ログだけにする。
REQ-08-051 と制約5に対応する。

**対象要件** REQ-08-051
**前提タスク** T-IAC-44
**成果物** `infra/tests/destroy-residue.sh`, `infra/envs/demo/lifecycle-flags.tf`, `.github/workflows/infra-cycle.yml`

**実装方針**
- destroy を妨げるフラグを全リソースで無効側に倒す。GCS バケットは `force_destroy = true`、BigQuery dataset は `delete_contents_on_destroy = true`、BigQuery table は `deletion_protection = false`、Firestore は `deletion_policy = "DELETE"` と `delete_protection_state = "DELETE_PROTECTION_DISABLED"`、Artifact Registry は削除可のまま。
- `lifecycle { prevent_destroy = true }` を書いてよいのは shared state の KMS CryptoKey と CryptoKey Ring、および bootstrap の state バケットだけ。demo state のどのリソースにも書かない。
- `infra/tests/destroy-residue.sh` は demo の destroy 後に `gcloud run services list`、`gcloud run jobs list`、`gcloud storage buckets list --filter='name~jwks OR name~platform-config'`、`gcloud pubsub topics list`、`gcloud scheduler jobs list` がすべて空であることを検査する。KMS と Artifact Registry と state バケットは検査対象から外す。
- `.github/workflows/infra-cycle.yml` は `shared apply` → `demo apply` → 検査 → `demo destroy` → `destroy-residue.sh` → `demo apply` を1ジョブで通す。shared の destroy は行わない。
- 2回目の apply で KMS 鍵を import せず同名で再利用できることを、shared state を destroy しない運用で担保する。この手順を `infra/README.md` に書く（T-IAC-47）。

**完了条件**
- [~] `bash infra/tests/destroy-residue.sh` が demo destroy 後に exit code 0 を返す（デプロイ後に `infra/tests/destroy-residue.sh` が観測する）
- [~] CI ジョブ `infra-cycle` が apply → destroy → apply を1回で通す（デプロイ後に `.github/workflows/infra-cycle.yml` の demo-apply / demo-destroy 段が観測する）
- [x] `grep -rn 'prevent_destroy' infra/envs/demo/` が0件
- [~] `terraform destroy` が deletion protection のエラーで失敗しない（デプロイ後に `scripts/deploy-gcp-guide.sh` の deploy 段が観測する）

---

### T-IAC-46 Makefile に apply から destroy までの運用手順を書く

**概要**
3 state の apply 順序、イメージのビルド、seed の投入、検査の実行、destroy までを1つの Makefile にまとめる。
apply 後に3つの検査を自動実行し、通らなければ次へ進めない形にする。
DEC-IAC-19 に対応する。

**対象要件** なし（DEC-IAC-19）
**前提タスク** T-IAC-45
**成果物** `Makefile`, `infra/tfvars/demo.tfvars.example`, `infra/tfvars/verify.tfvars`

**実装方針**
- ターゲットは `bootstrap` `shared-apply` `images` `demo-apply` `seed` `verify` `purge-runtime` `demo-destroy` `all` の9つ。
- `demo-apply` は `terraform apply` の後に `verify` を必ず呼ぶ。`verify` は `reachability.sh` と `forbidden-roles.sh` と `invoker-matrix.sh` の3件を順に実行し、1件でも失敗したら非ゼロ終了する。
- `seed` は `jwks-publish` Job の実行、`seed` Job の実行の順で直列に呼ぶ。並列実行しない。
- `images` は `scripts/build-push.sh` を呼び、タグに `git rev-parse --short HEAD` を使う。`latest` タグを使わない。
- `purge-runtime` は `scripts/purge-runtime-resources.sh` を呼ぶ。
  ラベル `xaa-managed=runtime` を持つ Cloud Run Service と Job、`description` に同じ印を持つ Service Account、`idjag-` と `idpconn-` で始まる CryptoKey の鍵バージョンを列挙して消す。
  実行時に作った Dedicated OP 一式は Terraform の state に載らないため、`terraform destroy` では消えない（DEC-IAC-25）。
- `demo-destroy` は `purge-runtime` を先に呼んでから `terraform destroy` を実行する。順序を逆にしない。
  Terraform を先に消すと Cloud Run と Service Account を列挙する経路が残らず、孤児を回収できなくなる。
- `max_full_isolation_agents` は demo state だけが使う。shared state へは渡さない。
- `verify.tfvars` は検証プロファイルとし、`agent_max_lifetime_seconds = 3600`、`max_full_isolation_agents = 2`、`issuer_profile = "direct"`、`enable_google_bridge = false` を書く。
- `all` は `shared-apply` `images` `demo-apply` `seed` を順に呼ぶ。`bootstrap` と `demo-destroy` は `all` に含めない。
- 各ターゲットの先頭に `@echo` で何をするかを1行出す。手順の暗黙知を Makefile 外に残さない。

**完了条件**
- [~] `make all` が空プロジェクト（bootstrap 済み）に対してエラーなく完走する（デプロイ後に `scripts/deploy-gcp-guide.sh` の verify 段が観測する）
- [~] `make demo-apply` が `verify` の失敗時に非ゼロで終了する（デプロイ後に `scripts/deploy-gcp-guide.sh` の verify 段が観測する）
- [~] `make demo-destroy && make demo-apply && make seed` が連続で成功する（デプロイ後に `scripts/deploy-gcp-guide.sh` の verify 段が観測する）
- [~] FULL_ISOLATION の Agent を1体作った直後に `make demo-destroy` を実行すると、`gcloud run services list --filter='metadata.labels.xaa-managed=runtime'` と `gcloud iam service-accounts list --filter='description:xaa-managed=runtime'` がどちらも0件を返す（デプロイ後に `infra/tests/verify-all.sh` が観測する）
- [~] `make purge-runtime` を2回続けて実行しても2回とも終了コード0で終わる（デプロイ後に `Makefile` の purge-runtime 段が観測する）
- [x] `grep -c ':latest' Makefile scripts/build-images.sh` が0を返す

---

### T-IAC-47 infra/README に費用と残存リソースと分離の弱点を書く

**概要**
この構成は単一プロジェクトであるため、2プロジェクト構成より監査ログの保護が弱い。
その弱点と、destroy 後に残るもの、想定される費用を明文化し、読み手が判断できる状態にする。
DEC-IAC-11 と DEC-IAC-19 と制約5に対応する。

**対象要件** なし（DEC-IAC-11, DEC-SCOPE-01）
**前提タスク** T-IAC-46
**成果物** `infra/README.md`

**実装方針**
- 節を5つにする。「構成の前提」「運用手順」「destroy 後に残るもの」「費用の目安」「単一プロジェクトによる保護の弱まり」。
- 「構成の前提」に、3 state の役割、変数の一覧（名前 / 型 / 既定値 / 効果の4列表）、検証プロファイルの値を書く。
- 「運用手順」は Makefile のターゲットを順に並べ、各ターゲットの前提と所要時間の目安を書く。`reachability.sh` の実行に `roles/iam.serviceAccountTokenCreator` が要ることを明記する。
- 「destroy 後に残るもの」に、KMS Key Ring と CryptoKey が GCP 仕様上削除できないこと、再 apply 時に import せず同名で再利用する手順、state バケットと Artifact Registry を残す理由を書く。
- 「費用の目安」を、常時課金されるものと使った分だけ課金されるものの2表に分ける。常時側に Artifact Registry のストレージ、GCS の state と JWKS と config、KMS の鍵バージョン数、BigQuery のストレージ、Firestore のストレージ、`enable_lb_reservation = true` のときの予約 IP を挙げる。従量側に Cloud Run の実行時間（`min_instance_count = 0` により待機課金なし）、Vertex AI の推論、Pub/Sub と Cloud Logging の量を挙げる。金額は月額のオーダー（数十円 / 数百円 / 数千円）で書き、正確な単価を書かない。
- 「単一プロジェクトによる保護の弱まり」に、同一プロジェクトの Owner が実行系と監査ログの両方へ届くこと、`enable_deny_policy = false` では Owner による監査ログ削除を防げないこと、代替として `forbidden-roles.sh` を CI で常時走らせていることを書く。DEV-14 を参照する。
- Cloud SQL を採用しなかったこと（DEV-05）と、そのためデータ層の責務分離がアプリ側ラッパになっていることを「構成の前提」に1段落で書く。

**完了条件**
- [x] `infra/README.md` に上記5節がこの順で存在する
- [x] 変数一覧の表に、`infra/envs/*/variables*.tf` で宣言されている全変数が漏れなく載っている（`scripts/check-readme-vars.sh` が exit code 0）
- [x] 「費用の目安」に常時課金と従量課金の2表があり、常時課金側に6項目以上が挙がっている
- [x] 「単一プロジェクトによる保護の弱まり」に DEV-14 への参照と `forbidden-roles.sh` への参照がある

---

## このファイルで扱わない要件

| 要件ID | 扱わない理由 | 扱う領域とタスク |
|---|---|---|
| REQ-03-019 | Capability ID の命名規約は `packages/xaa-contracts` の定数表と検査関数が正であり、seed Job（T-IAC-27）はそれを import して呼ぶだけになる。規約そのものの定義と検査関数の実装は Authorization 領域が持つ | Authorization 領域 T-AUTHZ-06 |
