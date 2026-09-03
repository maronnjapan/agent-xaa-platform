#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)
cd "$repo_root"

command_name=all
dry_run=0
assume_yes=0
skip_quality_gate=0
allow_unverified=0
declare -a tf_command pnpm_command
temporary_verify_bindings=()

cleanup_verify_bindings() {
  ((${#temporary_verify_bindings[@]})) || return 0
  warn '検証用に追加した Service Account Token Creator binding を削除します。'
  local entry service_account principal
  for entry in "${temporary_verify_bindings[@]}"; do
    IFS=$'\t' read -r service_account principal <<<"$entry"
    gcloud iam service-accounts remove-iam-policy-binding "$service_account" \
      --project="$PROJECT_ID" --member="$principal" \
      --role=roles/iam.serviceAccountTokenCreator --quiet >/dev/null 2>&1 || \
      warn "$service_account の一時 binding を削除できませんでした。"
  done
  temporary_verify_bindings=()
}

trap cleanup_verify_bindings EXIT

usage() {
  cat <<'USAGE'
GCP プロジェクトの作成から Agent XAA Platform のデプロイまでを案内します。

Usage:
  scripts/deploy-gcp-guide.sh [all|doctor|auth|project|deploy|verify] [options]

Options:
  --dry-run             外部状態を変更せず、実行予定のコマンドを表示する
  --yes                 対話確認を省略する（CONFIRM_PROJECT_ID が必要）
  --skip-quality-gate   テストを省略する
  --allow-unverified    tasks/done の未完了監査を承知して続行する
  -h, --help            この説明を表示する

主な環境変数:
  PROJECT_ID                 作成または利用する一意な GCP project ID
  PROJECT_NAME               表示名。既定値は Agent XAA Demo
  BILLING_ACCOUNT_ID         請求先アカウント ID。新規作成時に必要
  ORGANIZATION_ID            プロジェクトの親 Organization。任意
  FOLDER_ID                  プロジェクトの親 Folder。任意
  REGION                     既定値は asia-northeast1
  GCP_AUTH_MODE              existing、browser、workforce のいずれか
  WORKFORCE_LOGIN_CONFIG     workforce 認証の login config JSON
  IMPERSONATE_SERVICE_ACCOUNT Terraform の ADC で偽装する SA。任意
  IMAGE_TAG                  既定値は Git commit SHA
  ENABLE_GOOGLE_BRIDGE       既定値は false
  SAAS_CONNECTOR_MODE        既定値は stub
  GOOGLE_OAUTH_CLIENT_SECRET_FILE Google OAuth secret を読むファイル。任意
  ROTATE_INTERNAL_SECRETS    1 のとき Human IdP client secret を追加する
  ROTATE_GOOGLE_OAUTH_SECRET 1 のとき Google OAuth secret を追加する
  GOOGLE_CONNECTOR_ID        OAuth client の redirect URI に使う connector id。既定値は google-workspace
  ALLOW_DIRTY                1 のとき dirty worktree のイメージ作成を許可する
  CONFIRM_PROJECT_ID         --yes 時の誤操作防止。PROJECT_ID と同じ値にする
  DEMO_LOGIN_USER            権限を付与するログインユーザー。testuser または otheruser
  GRANT_DEMO_PERMISSIONS     0 のときデモ用 Human Permission の付与を省く
  SKIP_ORG_POLICY_CHECK      1 のとき組織ポリシーの事前確認を省く

Terraform は ADC を使います。
サービスアカウント鍵 JSON は作成も読み込みもしません。
USAGE
}

while (($#)); do
  case "$1" in
    all|doctor|auth|project|deploy|verify) command_name=$1 ;;
    --dry-run) dry_run=1 ;;
    --yes) assume_yes=1 ;;
    --skip-quality-gate) skip_quality_gate=1 ;;
    --allow-unverified) allow_unverified=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n[%s] %s\n' "deploy-guide" "$*"; }
warn() { printf '[deploy-guide] WARNING: %s\n' "$*" >&2; }
die() { printf '[deploy-guide] ERROR: %s\n' "$*" >&2; exit 1; }

print_command() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
}

run() {
  print_command "$@"
  ((dry_run)) || "$@"
}

# 手で操作するしかない箇所は、どこを開いて何を入力するかまで書く。
# 「コンソールで設定してください」だけでは、読んだ人がここで止まってしまう。
manual_step() {
  local title=$1
  shift
  printf '\n────────────────────────────────────────────────────────────────\n'
  printf '[手動操作] %s\n' "$title"
  printf '────────────────────────────────────────────────────────────────\n'
  local line
  for line in "$@"; do printf '%s\n' "$line"; done
  printf '\n'
}

declare -a missing_prerequisites=()

prerequisite_guide() {
  case "$1" in
    gcloud)
      cat <<'GUIDE'
gcloud CLI (Google Cloud SDK) — 認証、プロジェクト作成、Cloud Run の操作に使います。
  https://cloud.google.com/sdk/docs/install?hl=ja
    1. 上のページから OS 用のアーカイブをダウンロードして展開する。
    2. `./google-cloud-sdk/install.sh` を実行し、PATH への追加に y と答える。
    3. シェルを開き直し、`gcloud version` が表示されることを確認する。
  macOS で Homebrew を使う場合は `brew install --cask google-cloud-sdk` でも入ります。
  Debian と Ubuntu の apt は https://cloud.google.com/sdk/docs/install#deb にあります。
GUIDE
      ;;
    terraform)
      cat <<'GUIDE'
Terraform 1.9.8 — infra/ の状態を apply します。このリポジトリはこのバージョンに固定しています。
  手順 A（mise で固定する。別バージョンが既に入っていてもそのまま使えるため推奨）
  https://mise.jdx.dev/getting-started.html
    1. `curl https://mise.run | sh`
    2. シェルの設定に `eval "$(mise activate bash)"` を書き足して開き直す（zsh なら bash を zsh に）。
    3. `mise use -g terraform@1.9.8`
  手順 B（HashiCorp の配布物を直接置く）
  https://developer.hashicorp.com/terraform/install
    1. 1.9.8 のバイナリをダウンロードし、PATH の通ったディレクトリに置く。
    2. `terraform version` が 1.9.8 を返すことを確認する。
GUIDE
      ;;
    node)
      cat <<'GUIDE'
Node.js 22 と pnpm — 品質ゲートと Human Permission の付与に使います。
  手順 A（mise。推奨）https://mise.jdx.dev/getting-started.html
    1. `curl https://mise.run | sh` のあとシェルを開き直す。
    2. `mise use -g node@22`
    3. `corepack enable pnpm`
  手順 B（公式インストーラ）https://nodejs.org/ja/download
    1. Node.js 22 系をインストールする。
    2. `corepack enable pnpm` を実行する（pnpm の入手方法は https://pnpm.io/ja/installation ）。
  `node --version` が v22 で始まり、`pnpm --version` が表示されれば準備完了です。
GUIDE
      ;;
    docker)
      cat <<'GUIDE'
Docker — 各アプリのイメージをビルドして Artifact Registry へ push します。
  https://docs.docker.com/get-started/get-docker/
    1. Docker Desktop（macOS と Windows）または Docker Engine（Linux）をインストールする。
    2. Linux では `sudo usermod -aG docker "$USER"` を実行し、ログインし直す。
    3. `docker info` がエラーなく表示されることを確認する。
GUIDE
      ;;
    jq)
      cat <<'GUIDE'
jq — gcloud と Terraform の JSON 出力を読み取ります。
  https://jqlang.github.io/jq/download/
    macOS: `brew install jq` / Debian と Ubuntu: `sudo apt-get install -y jq`
GUIDE
      ;;
    *)
      printf '%s — OS のパッケージマネージャでインストールしてください。\n' "$1"
      printf '  macOS: `brew install %s` / Debian と Ubuntu: `sudo apt-get install -y %s`\n' "$1" "$1"
      ;;
  esac
}

# 見つからないものを1件目で止めずに全部集めてから出す。
# 1件ずつ落ちると、入れて実行し直すたびに次の1件が出てくることになる。
require_command() {
  command -v "$1" >/dev/null 2>&1 || missing_prerequisites+=("$1")
}

flush_prerequisites() {
  ((${#missing_prerequisites[@]})) || return 0
  printf '\n[deploy-guide] ERROR: 実行に必要なものが %d 件そろっていません。\n' "${#missing_prerequisites[@]}" >&2
  printf '次の手順でインストールしてから、同じコマンドをもう一度実行してください。\n' >&2
  local tool
  for tool in "${missing_prerequisites[@]}"; do
    printf '\n────────────────────────────────────────────────────────────────\n' >&2
    prerequisite_guide "$tool" >&2
  done
  printf '\n' >&2
  exit 1
}

select_toolchains() {
  require_command gcloud
  require_command jq
  require_command curl
  require_command openssl
  require_command git
  [[ "$command_name" =~ ^(deploy|all)$ ]] && require_command docker

  if command -v terraform >/dev/null 2>&1 && [[ $(terraform version -json 2>/dev/null | jq -r .terraform_version) == 1.9.8 ]]; then
    tf_command=(terraform)
  elif command -v mise >/dev/null 2>&1 && mise exec terraform@1.9.8 -- terraform version >/dev/null 2>&1; then
    tf_command=(mise exec terraform@1.9.8 -- terraform)
  else
    missing_prerequisites+=(terraform)
  fi

  # pnpm も一緒に見る。node だけ 22 で pnpm が無いと、品質ゲートまで進んでから落ちる。
  if command -v node >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1 \
    && [[ $(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) == 22 ]]; then
    pnpm_command=(pnpm)
  elif command -v mise >/dev/null 2>&1 && mise exec node@22 -- pnpm --version >/dev/null 2>&1; then
    pnpm_command=(mise exec node@22 -- pnpm)
  else
    missing_prerequisites+=(node)
  fi

  flush_prerequisites
}

validate_settings() {
  REGION=${REGION:-asia-northeast1}
  PROJECT_NAME=${PROJECT_NAME:-Agent XAA Demo}
  GCP_AUTH_MODE=${GCP_AUTH_MODE:-existing}
  ENABLE_GOOGLE_BRIDGE=${ENABLE_GOOGLE_BRIDGE:-false}
  SAAS_CONNECTOR_MODE=${SAAS_CONNECTOR_MODE:-stub}
  DEMO_TFVARS=${DEMO_TFVARS:-infra/tfvars/verify.tfvars}
  CREATE_PROJECT=${CREATE_PROJECT:-auto}
  DEMO_LOGIN_USER=${DEMO_LOGIN_USER:-testuser}
  GRANT_DEMO_PERMISSIONS=${GRANT_DEMO_PERMISSIONS:-1}
  GOOGLE_CONNECTOR_ID=${GOOGLE_CONNECTOR_ID:-google-workspace}

  [[ "$GCP_AUTH_MODE" =~ ^(existing|browser|workforce)$ ]] || die 'GCP_AUTH_MODE は existing、browser、workforce のいずれかです。'
  [[ "$ENABLE_GOOGLE_BRIDGE" =~ ^(true|false)$ ]] || die 'ENABLE_GOOGLE_BRIDGE は true または false です。'
  [[ "$SAAS_CONNECTOR_MODE" =~ ^(stub|google)$ ]] || die 'SAAS_CONNECTOR_MODE は stub または google です。'
  [[ "$CREATE_PROJECT" =~ ^(auto|true|false)$ ]] || die 'CREATE_PROJECT は auto、true、false のいずれかです。'
  # Human IdP がパスワードを知っているのはこの2人だけ（apps/human-idp/src/oidc/store.ts）。
  # 他の名前へ権限を付けても、その名前ではログインできない。
  [[ "$DEMO_LOGIN_USER" =~ ^(testuser|otheruser)$ ]] || die 'DEMO_LOGIN_USER は testuser または otheruser です。'
  [[ -z ${ORGANIZATION_ID:-} || -z ${FOLDER_ID:-} ]] || die 'ORGANIZATION_ID と FOLDER_ID は同時に指定できません。'
  [[ -f "$DEMO_TFVARS" ]] || die "$DEMO_TFVARS が見つかりません。"

  if [[ "$command_name" =~ ^(project|deploy|verify|all)$ ]]; then
    if [[ -z ${PROJECT_ID:-} && -t 0 && $dry_run -eq 0 ]]; then
      read -r -p 'GCP project ID: ' PROJECT_ID
    fi
    [[ ${PROJECT_ID:-} =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die 'PROJECT_ID は6〜30文字の小文字、数字、ハイフンで指定してください。'
  fi

  if [[ -n ${IMAGE_TAG:-} ]]; then
    :
  else
    IMAGE_TAG=$(git rev-parse --short=12 HEAD)
  fi
  [[ "$IMAGE_TAG" =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || die 'IMAGE_TAG に OCI tag で使えない文字があります。'
}

doctor() {
  say 'ローカル実行環境を確認します。'
  select_toolchains
  validate_settings
  printf 'Terraform: %s\n' "$("${tf_command[@]}" version -json | jq -r .terraform_version)"
  printf 'Node.js: %s\n' "$(if ((${#pnpm_command[@]} == 1)); then node --version; else mise exec node@22 -- node --version; fi)"
  printf 'pnpm: %s\n' "$("${pnpm_command[@]}" --version)"
  gcloud version | sed -n '1p'
  if [[ "$command_name" =~ ^(deploy|all)$ ]] && ((!dry_run)) && ! docker info >/dev/null 2>&1; then
    manual_step 'Docker daemon を起動する' \
      'docker コマンドはありますが、daemon へ接続できません。イメージのビルドができない状態です。' \
      '' \
      '  macOS と Windows: Docker Desktop を起動し、鯨のアイコンが running になるまで待つ。' \
      '    https://docs.docker.com/desktop/' \
      '  Linux: `sudo systemctl start docker` を実行する。' \
      '    権限で失敗する場合は `sudo usermod -aG docker "$USER"` のあとログインし直す。' \
      '    https://docs.docker.com/engine/install/linux-postinstall/' \
      '' \
      '  `docker info` がエラーなく表示されるようになってから、同じコマンドを実行し直してください。'
    die 'Docker daemon に接続できません。'
  fi
}

quality_gate() {
  ((skip_quality_gate)) && { warn 'ローカル品質ゲートを省略します。'; return; }
  say 'コード、文書、Terraform のローカル品質ゲートを実行します。'
  run "${pnpm_command[@]}" install --frozen-lockfile
  run "${pnpm_command[@]}" typecheck
  run "${pnpm_command[@]}" lint
  run "${pnpm_command[@]}" test:unit
  run "${pnpm_command[@]}" test:integration
  run "${pnpm_command[@]}" test:e2e
  run "${pnpm_command[@]}" check:docs
  run bash infra/tests/static-all.sh
  run "${tf_command[@]}" fmt -check -recursive infra

  if ((dry_run)); then
    print_command "${pnpm_command[@]}" check:done
  elif ! "${pnpm_command[@]}" check:done; then
    if ((allow_unverified)); then
      warn 'tasks/done の完了証拠が不足しています。明示指定によりデプロイを続けます。'
    else
      die 'tasks/done の監査が未完了です。内容を修正するか、結果を承知した場合だけ --allow-unverified を指定してください。'
    fi
  fi
}

authenticate() {
  say 'gcloud CLI と Terraform 用 ADC を設定します。'
  case "$GCP_AUTH_MODE" in
    existing)
      if ((dry_run)); then
        print_command gcloud auth list --filter=status:ACTIVE --format='value(account)'
        print_command gcloud auth application-default print-access-token
      else
        [[ -n $(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1) ]] || die '有効な gcloud アカウントがありません。GCP_AUTH_MODE=browser または workforce を指定してください。'
        gcloud auth application-default print-access-token >/dev/null || die 'ADC がありません。GCP_AUTH_MODE=browser または workforce を指定してください。'
      fi
      ;;
    browser)
      run gcloud auth login --update-adc
      ;;
    workforce)
      [[ -n ${WORKFORCE_LOGIN_CONFIG:-} && -f "$WORKFORCE_LOGIN_CONFIG" ]] || die 'workforce 認証には WORKFORCE_LOGIN_CONFIG が必要です。'
      run gcloud auth login --login-config="$WORKFORCE_LOGIN_CONFIG" --update-adc
      ;;
  esac

  if [[ -n ${IMPERSONATE_SERVICE_ACCOUNT:-} ]]; then
    run gcloud auth application-default login --impersonate-service-account="$IMPERSONATE_SERVICE_ACCOUNT"
  fi
}

open_billing_account_ids() {
  gcloud billing accounts list --filter=open=true --format='value(name.basename())' 2>/dev/null || true
}

guide_billing_account_creation() {
  manual_step '請求先アカウントを用意する' \
    'Cloud Run、Artifact Registry、Firestore を作るため、有効な請求先アカウントが要ります。' \
    'いまこのアカウントからは、開いている請求先アカウントが1件も見えていません。' \
    '' \
    '  新しく作る場合: https://console.cloud.google.com/billing/create' \
    '    1. 国と通貨を選ぶ。通貨はあとから変更できません。' \
    '    2. アカウント名を入れ、支払い方法（クレジットカードなど）を登録する。' \
    '    3. 初めての利用なら無料トライアルのクレジットが付きます: https://cloud.google.com/free' \
    '    4. https://console.cloud.google.com/billing の一覧に出ることを確認する。' \
    '' \
    '  会社の請求先アカウントを使う場合: 管理者に roles/billing.user を依頼してください。' \
    '    https://cloud.google.com/billing/docs/how-to/billing-access'
}

choose_billing_account() {
  [[ -n ${BILLING_ACCOUNT_ID:-} ]] && return 0
  ((dry_run)) && die 'dry-run で新規作成を表示するには BILLING_ACCOUNT_ID を指定してください。'
  local ids
  ids=$(open_billing_account_ids)
  # 見えないまま先へ進めても gcloud billing projects link で落ちるだけなので、
  # ここで作り終わるまで待つ。実行し直しは求めない。
  while [[ -z "$ids" ]]; do
    guide_billing_account_creation
    [[ -t 0 ]] || die '使える請求先アカウントがありません。BILLING_ACCOUNT_ID を指定して実行し直してください。'
    read -r -p '用意できたら Enter を押してください（中止する場合は Ctrl+C）: ' _
    ids=$(open_billing_account_ids)
  done

  if [[ $(printf '%s\n' "$ids" | wc -l) -eq 1 ]]; then
    BILLING_ACCOUNT_ID=$ids
    say "請求先アカウント $BILLING_ACCOUNT_ID を使用します。"
    return 0
  fi

  say '使える請求先アカウントは次のとおりです。'
  gcloud billing accounts list --filter=open=true --format='table(name.basename(),displayName)'
  [[ -t 0 ]] || die '請求先アカウントが複数あります。BILLING_ACCOUNT_ID を指定してください。'
  while :; do
    read -r -p 'Billing account ID: ' BILLING_ACCOUNT_ID
    printf '%s\n' "$ids" | grep -qxF "$BILLING_ACCOUNT_ID" && return 0
    warn '一覧に無い ID です。XXXXXX-XXXXXX-XXXXXX の形式で、上の表から選んでください。'
  done
}

# この構成は Automation App と Human IdP と Agent OP Callback を allUsers へ公開する。
# 組織のドメイン制限共有が効いていると demo の apply が途中で落ちるため、
# 15分かけて apply する前に見ておく。
check_domain_restricted_sharing() {
  ((dry_run)) && return 0
  [[ ${SKIP_ORG_POLICY_CHECK:-0} == 1 ]] && return 0
  local policy
  policy=$(gcloud org-policies describe constraints/iam.allowedPolicyMemberDomains \
    --project="$PROJECT_ID" --effective --format=json 2>/dev/null) \
    || policy=$(gcloud resource-manager org-policies describe constraints/iam.allowedPolicyMemberDomains \
      --project="$PROJECT_ID" --effective --format=json 2>/dev/null) \
    || return 0
  jq -e '[(.spec.rules[]?.values.allowedValues[]?), (.listPolicy.allowedValues[]?)] | length > 0' \
    <<<"$policy" >/dev/null || return 0

  manual_step '組織ポリシー「ドメインの制限された共有」に例外を追加する' \
    'iam.allowedPolicyMemberDomains が許可ドメインを列挙しています。' \
    'このままだと allUsers への公開が拒否され、demo の apply が' \
    '"One or more users named in the policy do not belong to a permitted customer" で落ちます。' \
    '' \
    "  設定ページ: https://console.cloud.google.com/iam-admin/orgpolicies/iam-allowedPolicyMemberDomains?project=$PROJECT_ID" \
    '    1. 上のページを開き、［ポリシーを管理］を押す。' \
    '    2. ［親のポリシーをオーバーライドする］を選ぶ。' \
    "    3. ［ルールを追加］で［すべて許可］を選び、$PROJECT_ID に適用する。" \
    '    4. 保存し、反映まで数分待つ。' \
    '' \
    '  組織ポリシー管理者 (roles/orgpolicy.policyAdmin) が要ります。付与の手順は' \
    '  https://cloud.google.com/resource-manager/docs/organization-policy/restricting-domains にあります。' \
    '' \
    '  この確認を飛ばす場合は SKIP_ORG_POLICY_CHECK=1 を指定してください。'
  die '組織ポリシーが allUsers への公開を拒否する設定のままです。'
}

configure_project() {
  say "GCP プロジェクト $PROJECT_ID を確認します。"
  local exists=0
  if ((dry_run)); then
    case "$CREATE_PROJECT" in
      true) exists=0 ;;
      false) exists=1 ;;
      auto) warn 'dry-run ではプロジェクトの実在を照会しないため、既存プロジェクトとして表示します。CREATE_PROJECT=true で作成手順を表示できます。'; exists=1 ;;
    esac
  elif gcloud projects describe "$PROJECT_ID" --format='value(projectId)' >/dev/null 2>&1; then
    exists=1
  fi

  if ((exists == 0)); then
    [[ "$CREATE_PROJECT" != false ]] || die "$PROJECT_ID は存在せず、CREATE_PROJECT=false が指定されています。"
    choose_billing_account
    local -a parent=()
    [[ -z ${ORGANIZATION_ID:-} ]] || parent+=(--organization="$ORGANIZATION_ID")
    [[ -z ${FOLDER_ID:-} ]] || parent+=(--folder="$FOLDER_ID")
    run gcloud projects create "$PROJECT_ID" --name="$PROJECT_NAME" "${parent[@]}"
    run gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT_ID"
  else
    say '既存プロジェクトを使用します。'
    if ((dry_run)); then
      print_command gcloud billing projects describe "$PROJECT_ID"
    else
      local billing_json current_billing billing_enabled
      billing_json=$(gcloud billing projects describe "$PROJECT_ID" --format=json)
      billing_enabled=$(jq -r '.billingEnabled // false' <<<"$billing_json")
      current_billing=$(jq -r '.billingAccountName // "" | split("/")[-1]' <<<"$billing_json")
      if [[ "$billing_enabled" != true ]]; then
        choose_billing_account
        run gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT_ID"
      elif [[ -n ${BILLING_ACCOUNT_ID:-} && "$current_billing" != "$BILLING_ACCOUNT_ID" ]]; then
        [[ ${ALLOW_BILLING_CHANGE:-0} == 1 ]] || die '既存の請求先を変更するには ALLOW_BILLING_CHANGE=1 が必要です。'
        run gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT_ID"
      fi
    fi
  fi

  run gcloud config set project "$PROJECT_ID"
  run gcloud auth application-default set-quota-project "$PROJECT_ID"
  check_domain_restricted_sharing
  run gcloud services enable \
    serviceusage.googleapis.com cloudresourcemanager.googleapis.com \
    cloudbilling.googleapis.com storage.googleapis.com \
    --project="$PROJECT_ID"
}

confirm_mutations() {
  ((dry_run)) && return
  printf '\n対象 project: %s\nregion: %s\nimage tag: %s\n' "$PROJECT_ID" "$REGION" "$IMAGE_TAG"
  printf 'demo destroy 後も state bucket、KMS、Artifact Registry などが残ります。\n'
  if ((assume_yes)); then
    [[ ${CONFIRM_PROJECT_ID:-} == "$PROJECT_ID" ]] || die '--yes では CONFIRM_PROJECT_ID を PROJECT_ID と同じ値にしてください。'
    return
  fi
  [[ -t 0 ]] || die '非対話実行では --yes と CONFIRM_PROJECT_ID が必要です。'
  local answer
  read -r -p "続行するには project ID ($PROJECT_ID) を再入力してください: " answer
  [[ "$answer" == "$PROJECT_ID" ]] || die 'project ID が一致しません。'
}

terraform_plan_apply() {
  local directory=$1 label=$2
  shift 2
  local plan_file="${TMPDIR:-/tmp}/agent-xaa-${label}-${PROJECT_ID}-$$.tfplan"
  run "${tf_command[@]}" -chdir="$directory" plan -input=false -out="$plan_file" "$@"
  run "${tf_command[@]}" -chdir="$directory" apply -input=false "$plan_file"
  if ((!dry_run)); then rm -f -- "$plan_file"; fi
}

apply_bootstrap_and_shared() {
  say 'Terraform state bucket を作成します。'
  run "${tf_command[@]}" -chdir=infra/bootstrap init -input=false -lockfile=readonly
  terraform_plan_apply infra/bootstrap bootstrap \
    -var="project_id=$PROJECT_ID" -var="region=$REGION"

  say '共有リソースを作成します。'
  run "${tf_command[@]}" -chdir=infra/envs/shared init -input=false -lockfile=readonly -reconfigure \
    -backend-config="bucket=$PROJECT_ID-tfstate"
  terraform_plan_apply infra/envs/shared shared \
    -var="project_id=$PROJECT_ID" -var="region=$REGION"
}

secret_has_enabled_version() {
  [[ -n $(gcloud secrets versions list "$1" --project="$PROJECT_ID" --filter='state=ENABLED' --limit=1 --format='value(name)' 2>/dev/null) ]]
}

add_generated_secret_version() {
  local secret_name=$1
  if ((!dry_run)) && [[ ${ROTATE_INTERNAL_SECRETS:-0} != 1 ]] && secret_has_enabled_version "$secret_name"; then
    say "$secret_name には有効な version があるため再利用します。"
    return
  fi
  say "$secret_name の値を生成し、標準出力へ出さずに Secret Manager へ追加します。"
  if ((dry_run)); then
    printf '+ openssl rand -base64 48 | gcloud secrets versions add %q --project=%q --data-file=-  # value redacted\n' "$secret_name" "$PROJECT_ID"
  else
    openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add "$secret_name" --project="$PROJECT_ID" --data-file=- >/dev/null
  fi
}

# Cloud Run の既定ホスト名は project number と region から決まるので、
# apply の前でも redirect URI を確定して見せられる。
bridge_callback_base_url() {
  local number
  number=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)' 2>/dev/null) || number=''
  if [[ -z "$number" ]]; then
    printf 'https://google-bridge-callback-<project-number>.%s.run.app' "$REGION"
    return 0
  fi
  printf 'https://google-bridge-callback-%s.%s.run.app' "$number" "$REGION"
}

guide_google_oauth_client() {
  local redirect_uri
  redirect_uri="$(bridge_callback_base_url)/$GOOGLE_CONNECTOR_ID/oauth/callback"
  manual_step 'Google OAuth client を作成する' \
    'Google Bridge が外部 SaaS との OAuth 接続を持つため、ウェブアプリケーション種別の client が要ります。' \
    'ブラウザで次の4ページを上から順に設定してください。' \
    '' \
    "  1. ブランディング: https://console.cloud.google.com/auth/branding?project=$PROJECT_ID" \
    '       アプリ名、ユーザーサポートメール、デベロッパーの連絡先情報を入れて保存する。' \
    "  2. 対象: https://console.cloud.google.com/auth/audience?project=$PROJECT_ID" \
    '       ユーザーの種類に「外部」を選び、テストユーザーへ自分の Google アカウントを追加する。' \
    "  3. データアクセス: https://console.cloud.google.com/auth/scopes?project=$PROJECT_ID" \
    '       接続先 API のスコープを追加する（例 https://www.googleapis.com/auth/calendar.readonly）。' \
    "  4. クライアント: https://console.cloud.google.com/auth/clients/create?project=$PROJECT_ID" \
    '       アプリケーションの種類に「ウェブ アプリケーション」を選ぶ。' \
    '       「承認済みのリダイレクト URI」へ次の値をそのまま貼り付ける。' \
    "         $redirect_uri" \
    '       作成すると client ID と client secret が表示されます。secret はこのあと入力してもらいます。' \
    '' \
    "  redirect URI の connector id を変える場合は GOOGLE_CONNECTOR_ID=<id> を指定して実行し直してください。" \
    "  作成済みの client は https://console.cloud.google.com/auth/clients?project=$PROJECT_ID で見られます。"
}

add_google_oauth_secret_version() {
  local secret_name=google-oauth-client-secret
  if ((!dry_run)) && [[ ${ROTATE_GOOGLE_OAUTH_SECRET:-0} != 1 ]] && secret_has_enabled_version "$secret_name"; then
    say "$secret_name には有効な version があるため再利用します。"
    return
  fi
  guide_google_oauth_client
  if [[ -n ${GOOGLE_OAUTH_CLIENT_SECRET_FILE:-} ]]; then
    [[ -f "$GOOGLE_OAUTH_CLIENT_SECRET_FILE" ]] || die 'GOOGLE_OAUTH_CLIENT_SECRET_FILE が見つかりません。'
    run gcloud secrets versions add "$secret_name" --project="$PROJECT_ID" --data-file="$GOOGLE_OAUTH_CLIENT_SECRET_FILE"
  elif ((dry_run)); then
    printf '+ read -s GOOGLE_OAUTH_CLIENT_SECRET | gcloud secrets versions add %q --project=%q --data-file=-  # value redacted\n' "$secret_name" "$PROJECT_ID"
  elif [[ -t 0 ]]; then
    local secret_value
    read -r -s -p 'Google OAuth client secret: ' secret_value
    printf '\n'
    [[ -n "$secret_value" ]] || die 'Google OAuth client secret が空です。'
    printf '%s' "$secret_value" | gcloud secrets versions add "$secret_name" --project="$PROJECT_ID" --data-file=- >/dev/null
    unset secret_value
  else
    die 'Google OAuth client secret の version がありません。GOOGLE_OAUTH_CLIENT_SECRET_FILE を指定してください。'
  fi

  # ここから先は現時点の実装に経路が無い。黙って進めると、Bridge が配備された状態で
  # 接続だけが動かず、原因が分からないまま止まる。
  manual_step 'Bridge の connector 定義について' \
    'Bridge は Firestore の connector_definitions/<connector_id> を読んで接続先を決めます。' \
    'この行を書き込む経路は現時点の実装に含まれていません。' \
    'ENABLE_GOOGLE_BRIDGE=true は Bridge サービスの配備と secret の登録までを行い、' \
    '外部 SaaS への実接続はここで止まります。' \
    '' \
    '  行に必要な値:' \
    "    connector_id  = $GOOGLE_CONNECTOR_ID" \
    '    client_id     = 作成した OAuth client の client ID' \
    "    secret_name   = $secret_name" \
    '    各 endpoint   = https://accounts.google.com/o/oauth2/v2/auth などの Google の値' \
    '  詳細は docs/06-oauth-bridge.md と apps/google-bridge/src/connectors/types.ts にあります。'
}

provision_secret_values() {
  say 'アプリの Secret version を用意します。'
  add_generated_secret_version human-idp-automation-client-secret
  add_generated_secret_version human-idp-agent-platform-client-secret
  if [[ "$ENABLE_GOOGLE_BRIDGE" == true && "$SAAS_CONNECTOR_MODE" == google ]]; then
    add_google_oauth_secret_version
  fi
}

build_and_push_images() {
  say 'コンテナイメージをビルドして Artifact Registry へ push します。'
  if ((!dry_run)) && [[ -n $(git status --porcelain) && ${ALLOW_DIRTY:-0} != 1 ]]; then
    die 'worktree に未コミット変更があります。commit するか ALLOW_DIRTY=1 を指定してください。'
  fi
  local registry="$REGION-docker.pkg.dev/$PROJECT_ID/xaa"
  run gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet
  run env REGISTRY="$registry" IMAGE_TAG="$IMAGE_TAG" bash scripts/build-images.sh
}

apply_demo() {
  say 'Cloud Run、Firestore、Pub/Sub、Scheduler と IAM を apply します。'
  run "${tf_command[@]}" -chdir=infra/envs/demo init -input=false -lockfile=readonly -reconfigure \
    -backend-config="bucket=$PROJECT_ID-tfstate"
  terraform_plan_apply infra/envs/demo demo \
    -var-file="../../../$DEMO_TFVARS" \
    -var="project_id=$PROJECT_ID" -var="region=$REGION" -var="image_tag=$IMAGE_TAG" \
    -var="enable_google_bridge=$ENABLE_GOOGLE_BRIDGE" -var="saas_connector_mode=$SAAS_CONNECTOR_MODE"
}

wait_for_services() {
  say 'Cloud Run Service の Ready 状態を待ちます。'
  local -a services=(human-idp automation-app authorization provisioner lifecycle shared-agent-op agent-op-callback security-detection resource-finance-as resource-finance-api resource-docs-as resource-docs-api)
  if [[ "$ENABLE_GOOGLE_BRIDGE" == true ]]; then
    services+=(google-bridge google-bridge-callback)
    [[ "$SAAS_CONNECTOR_MODE" != stub ]] || services+=(stub-saas-op stub-saas-api)
  fi
  for service in "${services[@]}"; do
    if ((dry_run)); then
      print_command gcloud run services describe "$service" --project="$PROJECT_ID" --region="$REGION" --format=json
      continue
    fi
    local ready=false
    for _ in {1..60}; do
      if gcloud run services describe "$service" --project="$PROJECT_ID" --region="$REGION" --format=json \
        | jq -e '.status.conditions[]? | select(.type=="Ready" and .status=="True")' >/dev/null; then
        ready=true
        break
      fi
      sleep 5
    done
    [[ "$ready" == true ]] || die "$service が Ready になりません。gcloud run services logs read $service で確認してください。"
  done
}

bootstrap_sso_and_seed() {
  say 'Human IdP の SSO 署名鍵を初期化します。'
  local issuer
  if ((dry_run)); then
    issuer="https://<human-idp-url>"
    print_command curl -fsS "$issuer/jwks.json"
    print_command gcloud storage ls "gs://$PROJECT_ID-platform-config/sso-signing/current.json"
  else
    issuer=$("${tf_command[@]}" -chdir=infra/envs/demo output -json platform_endpoints | jq -r .issuer)
    curl -fsS "$issuer/jwks.json" | jq -e '.keys | length >= 1' >/dev/null
    gcloud storage ls "gs://$PROJECT_ID-platform-config/sso-signing/current.json" >/dev/null
    say 'SSO 秘密鍵は KMS で包まれたオブジェクトとして存在します。平文は取得しません。'
  fi

  say '共有 JWKS を集約してから定義データを投入します。'
  run gcloud run jobs execute jwks-publish --project="$PROJECT_ID" --region="$REGION" --wait
  run gcloud run jobs execute seed --project="$PROJECT_ID" --region="$REGION" --wait
}

verify_deployment() {
  say 'IAM 到達性と権限を検証します。'
  prepare_verify_impersonation
  run env PROJECT_ID="$PROJECT_ID" REGION="$REGION" TF="${tf_command[*]}" bash infra/tests/verify-all.sh
  cleanup_verify_bindings
  if ((dry_run)); then
    print_command "${tf_command[@]}" -chdir=infra/envs/demo output -json platform_endpoints
  else
    say '公開エンドポイントを表示します。'
    "${tf_command[@]}" -chdir=infra/envs/demo output -json platform_endpoints | jq '{issuer, authorization_url, provisioner_url, lifecycle_url}'
  fi
}

# seed が入れる human_permissions は user-123 と user-456 のもので、
# Human IdP がパスワードを持つ testuser と otheruser のものではない。
# 付けずに終わると、ログインはできるのに権限が空で、自動化を1つも定義できない。
grant_demo_permissions() {
  if [[ "$GRANT_DEMO_PERMISSIONS" != 1 ]]; then
    warn 'デモ用 Human Permission の付与を省きます。ログインしても権限は空のままです。'
    return 0
  fi
  say "ログインユーザー $DEMO_LOGIN_USER へ Human Permission を付与します。"
  # Bridge を配備していないときに calendar を付けても、seed が対応する Tool を落とすため
  # Capability だけが宙に浮く。配備した分だけ付ける。
  local -a capabilities=(document.read document.write finance.payment.read finance.payment.approve)
  [[ "$ENABLE_GOOGLE_BRIDGE" == true ]] && capabilities+=(calendar.event.read)
  if ((!dry_run)); then
    [[ -d node_modules ]] || run "${pnpm_command[@]}" install --frozen-lockfile
    # perm:set は dist を実行する。依存パッケージも一緒に組み上がる filter を使う。
    [[ -f apps/authorization/dist/perm-set-cli.js ]] || run "${pnpm_command[@]}" --filter '@xaa/authorization...' build
  fi
  local capability
  for capability in "${capabilities[@]}"; do
    run env GOOGLE_CLOUD_PROJECT="$PROJECT_ID" STORE_MODE=gcp PUBSUB_MODE=gcp \
      "${pnpm_command[@]}" perm:set "$DEMO_LOGIN_USER" "$capability" grant
  done
}

print_next_steps() {
  local automation_app_url issuer_url
  if ((dry_run)); then
    print_command "${tf_command[@]}" -chdir=infra/envs/demo output -json service_urls
    automation_app_url="https://automation-app-<project-number>.$REGION.run.app"
    issuer_url="https://human-idp-<project-number>.$REGION.run.app"
  else
    # 案内の表示で全体を落とさない。output が読めなければ既定のホスト名の形を見せる。
    local urls
    urls=$("${tf_command[@]}" -chdir=infra/envs/demo output -json service_urls 2>/dev/null) || urls='{}'
    automation_app_url=$(jq -r --arg fallback "https://automation-app-<project-number>.$REGION.run.app" \
      '."automation-app" // $fallback' <<<"$urls")
    issuer_url=$(jq -r --arg fallback "https://human-idp-<project-number>.$REGION.run.app" \
      '."human-idp" // $fallback' <<<"$urls")
  fi

  manual_step 'デプロイ後にアプリを操作する' \
    "  1. ブラウザで Automation App を開く: $automation_app_url" \
    "  2. Human IdP ($issuer_url) のログイン画面で次を入力する。" \
    "       ユーザー名: $DEMO_LOGIN_USER" \
    '       パスワード: password' \
    '     ログインできるのは testuser と otheruser の2人だけで、どちらもパスワードは password です。' \
    '     この2人は apps/human-idp/src/oidc/store.ts が持つ固定ユーザーです。' \
    '  3. 画面の対話で自動化したい内容を書き、提示された Agent Definition を承認する。' \
    '  4. 実行の様子は同じ画面の Activity タイムラインで追えます。' \
    '' \
    "  Cloud Run:  https://console.cloud.google.com/run?project=$PROJECT_ID" \
    "  Firestore:  https://console.cloud.google.com/firestore/databases/xaa/data?project=$PROJECT_ID" \
    "  ログ:       https://console.cloud.google.com/logs/query?project=$PROJECT_ID" \
    '' \
    '  権限を足す、または外す:' \
    "    GOOGLE_CLOUD_PROJECT=$PROJECT_ID STORE_MODE=gcp PUBSUB_MODE=gcp pnpm perm:set <user> <capability_id> <grant|revoke>" \
    '  破棄:' \
    "    PROJECT_ID=$PROJECT_ID REGION=$REGION DEMO_TFVARS=$DEMO_TFVARS TF='${tf_command[*]}' make demo-destroy"

  warn 'Automation App と Human IdP はインターネットへ公開され、ログイン情報は固定です。検証が終わったら demo-destroy してください。'
}

prepare_verify_impersonation() {
  if ((dry_run)); then
    say '到達性検証では、呼び出し元 SA ごとの一時的な Token Creator binding を必要な場合だけ追加し、検証後に削除します。'
    return
  fi

  local account principal edges service_account policy
  account=${VERIFY_PRINCIPAL:-$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)}
  [[ -n "$account" ]] || die '検証主体を特定できません。VERIFY_PRINCIPAL を IAM member 形式で指定してください。'
  if [[ "$account" == user:* || "$account" == serviceAccount:* || "$account" == principal://* || "$account" == principalSet://* ]]; then
    principal=$account
  elif [[ "$account" == *'.gserviceaccount.com' ]]; then
    principal="serviceAccount:$account"
  elif [[ "$account" == *@* ]]; then
    principal="user:$account"
  else
    die 'Workforce Identity の検証主体は VERIFY_PRINCIPAL を IAM member 形式で指定してください。'
  fi

  edges=$("${tf_command[@]}" -chdir=infra/envs/demo output -json invoker_edges)
  while IFS= read -r service_account; do
    [[ -n "$service_account" ]] || continue
    policy=$(gcloud iam service-accounts get-iam-policy "$service_account" --project="$PROJECT_ID" --format=json)
    if jq -e --arg member "$principal" '
      any(.bindings[]?; .role == "roles/iam.serviceAccountTokenCreator" and any(.members[]?; . == $member))
    ' <<<"$policy" >/dev/null; then
      continue
    fi
    run gcloud iam service-accounts add-iam-policy-binding "$service_account" \
      --project="$PROJECT_ID" --member="$principal" \
      --role=roles/iam.serviceAccountTokenCreator --quiet
    temporary_verify_bindings+=("$service_account"$'\t'"$principal")
  done < <(jq -r 'to_entries[].value.member | sub("^serviceAccount:"; "")' <<<"$edges" | sort -u)
}

deploy() {
  apply_bootstrap_and_shared
  provision_secret_values
  build_and_push_images
  apply_demo
  wait_for_services
  bootstrap_sso_and_seed
  grant_demo_permissions
}

doctor
case "$command_name" in
  doctor) ;;
  auth) authenticate ;;
  project) authenticate; configure_project ;;
  deploy) quality_gate; authenticate; confirm_mutations; configure_project; deploy; print_next_steps ;;
  verify) authenticate; verify_deployment; print_next_steps ;;
  all) quality_gate; authenticate; confirm_mutations; configure_project; deploy; verify_deployment; print_next_steps ;;
esac
