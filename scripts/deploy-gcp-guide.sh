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
  ALLOW_DIRTY                1 のとき dirty worktree のイメージ作成を許可する
  CONFIRM_PROJECT_ID         --yes 時の誤操作防止。PROJECT_ID と同じ値にする

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

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 が見つかりません。"
}

select_toolchains() {
  require_command gcloud
  require_command jq
  require_command curl
  require_command openssl
  require_command git

  if command -v terraform >/dev/null 2>&1 && [[ $(terraform version -json 2>/dev/null | jq -r .terraform_version) == 1.9.8 ]]; then
    tf_command=(terraform)
  elif command -v mise >/dev/null 2>&1; then
    tf_command=(mise exec terraform@1.9.8 -- terraform)
    "${tf_command[@]}" version >/dev/null
  else
    die 'Terraform 1.9.8 が必要です。mise または Terraform 1.9.8 をインストールしてください。'
  fi

  if command -v node >/dev/null 2>&1 && [[ $(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) == 22 ]]; then
    pnpm_command=(pnpm)
  elif command -v mise >/dev/null 2>&1; then
    pnpm_command=(mise exec node@22 -- pnpm)
    "${pnpm_command[@]}" --version >/dev/null
  else
    die 'Node.js 22 と pnpm が必要です。'
  fi
}

validate_settings() {
  REGION=${REGION:-asia-northeast1}
  PROJECT_NAME=${PROJECT_NAME:-Agent XAA Demo}
  GCP_AUTH_MODE=${GCP_AUTH_MODE:-existing}
  ENABLE_GOOGLE_BRIDGE=${ENABLE_GOOGLE_BRIDGE:-false}
  SAAS_CONNECTOR_MODE=${SAAS_CONNECTOR_MODE:-stub}
  DEMO_TFVARS=${DEMO_TFVARS:-infra/tfvars/verify.tfvars}
  CREATE_PROJECT=${CREATE_PROJECT:-auto}

  [[ "$GCP_AUTH_MODE" =~ ^(existing|browser|workforce)$ ]] || die 'GCP_AUTH_MODE は existing、browser、workforce のいずれかです。'
  [[ "$ENABLE_GOOGLE_BRIDGE" =~ ^(true|false)$ ]] || die 'ENABLE_GOOGLE_BRIDGE は true または false です。'
  [[ "$SAAS_CONNECTOR_MODE" =~ ^(stub|google)$ ]] || die 'SAAS_CONNECTOR_MODE は stub または google です。'
  [[ "$CREATE_PROJECT" =~ ^(auto|true|false)$ ]] || die 'CREATE_PROJECT は auto、true、false のいずれかです。'
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
  if [[ "$command_name" =~ ^(deploy|all)$ ]]; then
    require_command docker
    ((dry_run)) || docker info >/dev/null 2>&1 || die 'Docker daemon に接続できません。'
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

choose_billing_account() {
  [[ -n ${BILLING_ACCOUNT_ID:-} ]] && return
  ((dry_run)) && die 'dry-run で新規作成を表示するには BILLING_ACCOUNT_ID を指定してください。'
  say '利用可能な有効な請求先アカウントを表示します。'
  gcloud billing accounts list --filter=open=true --format='table(name.basename(),displayName)'
  [[ -t 0 ]] || die 'BILLING_ACCOUNT_ID が必要です。'
  read -r -p 'Billing account ID: ' BILLING_ACCOUNT_ID
  [[ -n "$BILLING_ACCOUNT_ID" ]] || die 'BILLING_ACCOUNT_ID が空です。'
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

add_google_oauth_secret_version() {
  local secret_name=google-oauth-client-secret
  if ((!dry_run)) && [[ ${ROTATE_GOOGLE_OAUTH_SECRET:-0} != 1 ]] && secret_has_enabled_version "$secret_name"; then
    say "$secret_name には有効な version があるため再利用します。"
    return
  fi
  say 'Google Auth Platform で Web application の OAuth client を作成してください。'
  printf 'Console: https://console.cloud.google.com/auth/clients?project=%s\n' "$PROJECT_ID"
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
    printf 'Console: https://console.cloud.google.com/run?project=%s\n' "$PROJECT_ID"
    printf 'Destroy: PROJECT_ID=%q REGION=%q TF=%q make demo-destroy\n' "$PROJECT_ID" "$REGION" "${tf_command[*]}"
  fi
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
}

doctor
case "$command_name" in
  doctor) ;;
  auth) authenticate ;;
  project) authenticate; configure_project ;;
  deploy) quality_gate; authenticate; confirm_mutations; configure_project; deploy ;;
  verify) authenticate; verify_deployment ;;
  all) quality_gate; authenticate; confirm_mutations; configure_project; deploy; verify_deployment ;;
esac
