#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# このスクリプトは端末からの入力を一切待たない。all を始めたら、成功して使い方が出るか、
# 何が足りないかを言って落ちるかの二つしか終わり方が無い。途中で人を待つ設計だと、
# 席を外した30分がまるごと無駄になり、CI からも実行できない。
#
# 待たないためには、呼び出す側だけでなく呼ばれる側も黙らせる必要がある。
# gcloud は API 未有効時に "Would you like to enable and retry? (y/N)" を聞くことがあり、
# その問いを stderr ごと捨てている呼び出しでは、画面に何も出ないまま stdin を待ち続ける。
# terraform も変数が足りなければ同じことをする。まず両方を非対話に固定する。
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
export TF_IN_AUTOMATION=1
export TF_INPUT=0
export GIT_TERMINAL_PROMPT=0

# macOS ships bash 3.2, which rejects the empty arrays this script expands under set -u.
# A newer bash from Homebrew is used when present; otherwise the reader is told how to get one.
if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
  for candidate in /opt/homebrew/bin/bash /usr/local/bin/bash; do
    if [[ -x "$candidate" && -z ${DEPLOY_GUIDE_REEXEC:-} ]]; then
      DEPLOY_GUIDE_REEXEC=1 exec "$candidate" "$0" "$@"
    fi
  done
  printf '[deploy-guide] ERROR: bash 4.4 以上が必要です（いまは %s）。\n' "$BASH_VERSION" >&2
  printf '  macOS: `brew install bash` を実行し、もう一度同じコマンドを実行してください。\n' >&2
  printf '  Windows: WSL2 の Ubuntu を開き、その中でこのリポジトリを clone して実行してください。\n' >&2
  printf '    https://learn.microsoft.com/ja-jp/windows/wsl/install\n' >&2
  exit 1
fi

# 環境変数の設定は「聞かれても既定で答える」までで、聞く実装そのものは残る。
# ここで端末そのものを外す。以降どの子プロセスも stdin から読めば即座に EOF を受け取り、
# 待ち続けることができない。パイプ、ヒアストリング、プロセス置換は明示的な接続なので影響しない。
# ブラウザでのログインは localhost で待ち受ける仕組みなので、これでも成立する。
exec </dev/null

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)
cd "$repo_root"

command_name=all
dry_run=0
skip_quality_gate=0
allow_unverified=0
declare -a tf_command pnpm_command
temporary_verify_bindings=()
login_registration_verified=0

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

前提知識は要りません。足りないツールや手で行う操作は、URL と入力内容まで画面に出します。
macOS と Linux はそのまま、Windows は WSL2 の Ubuntu の中で実行してください。
初回の所要時間は 30〜60 分、費用は放置で月額約 $0.5、1日動かして $1.1〜1.5 です。

入力待ちで止まることはありません。足りない設定は最初にまとめて指摘して終わります。

Usage:
  scripts/deploy-gcp-guide.sh [all|doctor|auth|project|deploy|verify] [options]

  all      doctor → 品質ゲート → 認証 → プロジェクト → デプロイ → 検証 → 使い方の表示（既定）
  doctor   ローカルのツールがそろっているかだけを確認する
  auth     gcloud と Terraform 用の認証だけを行う
  project  プロジェクトの作成と請求先の関連付けまでを行う
  deploy   デプロイまでを行い、IAM 検証は行わない
  verify   配備済みの環境に対して IAM 検証だけを行う

Options:
  --dry-run             外部状態を変更せず、実行予定のコマンドを表示する
  --skip-quality-gate   テストを省略する
  --allow-unverified    tasks/done の未完了監査を承知して続行する
  --yes                 受け付けるが何もしない。確認待ちは元から無い
  -h, --help            この説明を表示する

主な環境変数:
  PROJECT_ID                 作成または利用する一意な GCP project ID。
                             省略時は gcloud config の project を使う
  PROJECT_NAME               表示名。既定値は Agent XAA Demo
  BILLING_ACCOUNT_ID         請求先アカウント ID。省略時は開いているものを自動で選ぶ
  ORGANIZATION_ID            プロジェクトの親 Organization。任意
  FOLDER_ID                  プロジェクトの親 Folder。任意
  REGION                     既定値は asia-northeast1
  GCP_AUTH_MODE              auto（既定）、existing、browser、workforce のいずれか。
                             auto はログイン済みならそれを使い、未ログインならブラウザを開く
  WORKFORCE_LOGIN_CONFIG     workforce 認証の login config JSON
  IMPERSONATE_SERVICE_ACCOUNT Terraform の ADC で偽装する SA。任意
  IMAGE_TAG                  既定値は Git commit SHA
  BUILD_JOBS                 イメージを何個ずつ並列に build と push するか。
                             既定値は CPU 数と 4 の小さい方。1 で逐次に戻す
  ENABLE_GOOGLE_BRIDGE       既定値は false
  SAAS_CONNECTOR_MODE        既定値は stub
  GOOGLE_OAUTH_CLIENT_ID     SAAS_CONNECTOR_MODE=google のとき seed が接続先定義に書く client ID
  GOOGLE_OAUTH_CLIENT_SECRET_FILE Google OAuth secret を読むファイル
  GOOGLE_OAUTH_CLIENT_SECRET Google OAuth secret を直接渡す。FILE の代わりに使う
  ROTATE_INTERNAL_SECRETS    1 のとき Human IdP client secret を追加する
  ROTATE_GOOGLE_OAUTH_SECRET 1 のとき Google OAuth secret を追加する
  GOOGLE_CONNECTOR_ID        OAuth client の redirect URI に使う connector id。既定値は google-workspace
  ALLOW_DIRTY                1 のとき dirty worktree のイメージ作成を許可する
  CONFIRM_PROJECT_ID         指定した場合だけ PROJECT_ID との一致を検査する誤操作防止
  DEMO_LOGIN_USER            権限を付与するログインユーザー。testuser または otheruser
  GRANT_DEMO_PERMISSIONS     0 のときデモ用 Human Permission の付与を省く
  SKIP_ORG_POLICY_CHECK      1 のとき組織ポリシーの事前確認を省く
  AUTO_FIX_ORG_POLICY        既定は1。ドメイン制限共有の例外をプロジェクトへ自動で追加する
  DEMO_TFVARS                demo state の変数ファイル。既定値は infra/tfvars/deploy.tfvars

Terraform は ADC を使います。
サービスアカウント鍵 JSON は作成も読み込みもしません。
USAGE
}

while (($#)); do
  case "$1" in
    all|doctor|auth|project|deploy|verify) command_name=$1 ;;
    --dry-run) dry_run=1 ;;
    --yes) ;;  # 互換のために受け取るだけ。待つ確認はもう無い
    --skip-quality-gate) skip_quality_gate=1 ;;
    --allow-unverified) allow_unverified=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# command_name ごとに呼ばれる phase の数を固定で持つ。数え方は各関数の定義を参照。
declare -A total_phases=([doctor]=1 [auth]=2 [project]=3 [deploy]=13 [verify]=4 [all]=14)
current_phase=0

elapsed() { printf '%02d:%02d' $((SECONDS / 60)) $((SECONDS % 60)); }
say() { printf '\n[%s +%s] %s\n' "deploy-guide" "$(elapsed)" "$*"; }
warn() { printf '[deploy-guide] WARNING: %s\n' "$*" >&2; }
# 止まるときは、何が足りないかと、次に打つコマンドまでを1回で出す。
# 2行目以降は補足として字下げして続ける。
die() {
  printf '[deploy-guide] ERROR: %s\n' "$1" >&2
  shift
  local line
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit 1
}

# all は初回 30〜60 分かかる。今どの段階で、始めてから何分経ったかが見えないと、
# 読み手には止まっているのか動いているのか区別できない。
phase() {
  current_phase=$((current_phase + 1))
  printf '\n════════════════════════════════════════════════════════════════\n'
  printf '[deploy-guide] STEP %d/%d ・ 経過 %s ・ %s\n' \
    "$current_phase" "${total_phases[$command_name]}" "$(elapsed)" "$*"
  printf '════════════════════════════════════════════════════════════════\n'
}

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
  GCP_AUTH_MODE=${GCP_AUTH_MODE:-auto}
  ENABLE_GOOGLE_BRIDGE=${ENABLE_GOOGLE_BRIDGE:-false}
  SAAS_CONNECTOR_MODE=${SAAS_CONNECTOR_MODE:-stub}
  # The same profile the deploy workflow applies on a merge to main, so a laptop run and
  # a merge produce the same deployment.
  DEMO_TFVARS=${DEMO_TFVARS:-infra/tfvars/deploy.tfvars}
  CREATE_PROJECT=${CREATE_PROJECT:-auto}
  DEMO_LOGIN_USER=${DEMO_LOGIN_USER:-testuser}
  GRANT_DEMO_PERMISSIONS=${GRANT_DEMO_PERMISSIONS:-1}
  GOOGLE_CONNECTOR_ID=${GOOGLE_CONNECTOR_ID:-google-workspace}

  [[ "$GCP_AUTH_MODE" =~ ^(auto|existing|browser|workforce)$ ]] || die 'GCP_AUTH_MODE は auto、existing、browser、workforce のいずれかです。'
  [[ "$ENABLE_GOOGLE_BRIDGE" =~ ^(true|false)$ ]] || die 'ENABLE_GOOGLE_BRIDGE は true または false です。'
  [[ "$SAAS_CONNECTOR_MODE" =~ ^(stub|google)$ ]] || die 'SAAS_CONNECTOR_MODE は stub または google です。'
  [[ "$CREATE_PROJECT" =~ ^(auto|true|false)$ ]] || die 'CREATE_PROJECT は auto、true、false のいずれかです。'
  # Human IdP がパスワードを知っているのはこの2人だけ（apps/human-idp/src/oidc/store.ts）。
  # 他の名前へ権限を付けても、その名前ではログインできない。
  [[ "$DEMO_LOGIN_USER" =~ ^(testuser|otheruser)$ ]] || die 'DEMO_LOGIN_USER は testuser または otheruser です。'
  [[ -z ${ORGANIZATION_ID:-} || -z ${FOLDER_ID:-} ]] || die 'ORGANIZATION_ID と FOLDER_ID は同時に指定できません。'
  [[ -f "$DEMO_TFVARS" ]] || die "$DEMO_TFVARS が見つかりません。"

  if [[ "$command_name" =~ ^(project|deploy|verify|all)$ ]]; then
    # 尋ねずに、既に答えのある場所を見る。gcloud で作業しているなら config に入っている。
    if [[ -z ${PROJECT_ID:-} ]] && ((!dry_run)); then
      PROJECT_ID=$(gcloud config get-value project 2>/dev/null) || PROJECT_ID=''
      [[ "$PROJECT_ID" == '(unset)' ]] && PROJECT_ID=''
      [[ -n "$PROJECT_ID" ]] && say "PROJECT_ID を gcloud config から取りました: $PROJECT_ID"
    fi
    if [[ -z ${PROJECT_ID:-} ]]; then
      die 'PROJECT_ID が決まりません。世界中で一意な名前を決めて指定してください。' \
        '6〜30文字の小文字、数字、ハイフンで、先頭は小文字です。既存プロジェクトの ID でも構いません。' \
        "例: PROJECT_ID=agent-xaa-$(date +%Y%m%d) scripts/deploy-gcp-guide.sh $command_name"
    fi
    [[ "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "PROJECT_ID ($PROJECT_ID) は6〜30文字の小文字、数字、ハイフンで指定してください。"
    # 指定された場合だけ検査する。誤ったプロジェクトを触らせないための任意の保険。
    if [[ -n ${CONFIRM_PROJECT_ID:-} && "$CONFIRM_PROJECT_ID" != "$PROJECT_ID" ]]; then
      die "CONFIRM_PROJECT_ID ($CONFIRM_PROJECT_ID) が PROJECT_ID ($PROJECT_ID) と一致しません。"
    fi
  fi

  if [[ -n ${IMAGE_TAG:-} ]]; then
    :
  else
    IMAGE_TAG=$(git rev-parse --short=12 HEAD)
  fi
  [[ "$IMAGE_TAG" =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || die 'IMAGE_TAG に OCI tag で使えない文字があります。'

  preflight_runtime_inputs
}

# 途中で人に尋ねない代わりに、後半で必要になる入力が全部そろっているかを、
# GCP を1つも変更していないこの時点で見る。20分 apply したあとで
# 「client secret を入力してください」と言われるのが、いちばん時間を捨てる止まり方だった。
preflight_runtime_inputs() {
  local -a missing=()

  if [[ "$GCP_AUTH_MODE" == workforce ]]; then
    [[ -n ${WORKFORCE_LOGIN_CONFIG:-} && -f "${WORKFORCE_LOGIN_CONFIG:-}" ]] \
      || missing+=('WORKFORCE_LOGIN_CONFIG に login config JSON のパスを指定してください（GCP_AUTH_MODE=workforce のため）。')
  fi

  if [[ "$command_name" =~ ^(deploy|all)$ && "$ENABLE_GOOGLE_BRIDGE" == true && "$SAAS_CONNECTOR_MODE" == google ]] && ((!dry_run)); then
    [[ -n ${GOOGLE_OAUTH_CLIENT_ID:-} ]] \
      || missing+=('GOOGLE_OAUTH_CLIENT_ID に <xxxx>.apps.googleusercontent.com を指定してください（SAAS_CONNECTOR_MODE=google のため）。')
    if [[ -n ${GOOGLE_OAUTH_CLIENT_SECRET_FILE:-} ]]; then
      [[ -f "$GOOGLE_OAUTH_CLIENT_SECRET_FILE" ]] \
        || missing+=("GOOGLE_OAUTH_CLIENT_SECRET_FILE ($GOOGLE_OAUTH_CLIENT_SECRET_FILE) が見つかりません。")
    elif [[ -z ${GOOGLE_OAUTH_CLIENT_SECRET:-} ]] && ! secret_has_enabled_version google-oauth-client-secret; then
      missing+=('GOOGLE_OAUTH_CLIENT_SECRET_FILE か GOOGLE_OAUTH_CLIENT_SECRET のどちらかで OAuth client secret を渡してください。')
    fi
    ((${#missing[@]})) && guide_google_oauth_client
  fi

  # イメージのタグは commit SHA なので、未コミットの変更はどのイメージにも入らない。
  # 気づくのが build 段（20分後）では遅いため、ここで見る。
  if [[ "$command_name" =~ ^(deploy|all)$ ]] && ((!dry_run)) \
    && [[ -n $(git status --porcelain) && ${ALLOW_DIRTY:-0} != 1 ]]; then
    missing+=('worktree に未コミットの変更があります。commit するか ALLOW_DIRTY=1 を指定してください。')
  fi

  ((${#missing[@]})) || return 0
  printf '\n[deploy-guide] ERROR: 実行前に決めておく設定が %d 件そろっていません。\n' "${#missing[@]}" >&2
  printf '入力待ちで止まらないよう、GCP を変更する前にまとめて報告します。\n' >&2
  local item
  for item in "${missing[@]}"; do printf '  - %s\n' "$item" >&2; done
  printf '\n' >&2
  exit 1
}

doctor() {
  phase 'ローカル実行環境を確認します。'
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
  phase 'コード、文書、Terraform のローカル品質ゲートを実行します。'
  ((skip_quality_gate)) && { warn 'ローカル品質ゲートを省略します。'; return; }
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

# Both halves are needed: gcloud commands use the account, Terraform and the permission
# CLI use Application Default Credentials.
gcloud_session_ready() {
  [[ -n $(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1) ]] \
    && gcloud auth application-default print-access-token >/dev/null 2>&1
}

browser_login() {
  manual_step 'ブラウザで Google アカウントにログインする' \
    'これからブラウザが開きます（開かない場合は端末に表示される URL を開いてください）。' \
    '  1. GCP を使う Google アカウントを選ぶ。会社の Google Workspace アカウントでも構いません。' \
    '  2. 「Google Cloud SDK が Google アカウントへのアクセスをリクエストしています」で［許可］を押す。' \
    '  3. 端末に戻り、次の段階が始まるのを待つ。' \
    '' \
    '  ブラウザの無いマシンで実行している場合は、この段でそのまま失敗します。' \
    '  別の端末で `gcloud auth login --update-adc --no-browser` の案内に従ってから、同じコマンドを実行し直してください。'
  run gcloud auth login --update-adc
}

authenticate() {
  phase 'gcloud CLI と Terraform 用 ADC を設定します。'
  case "$GCP_AUTH_MODE" in
    auto)
      if ((dry_run)); then
        print_command gcloud auth list --filter=status:ACTIVE --format='value(account)'
        print_command gcloud auth application-default print-access-token
      elif gcloud_session_ready; then
        say "ログイン済みの $(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1) を使います。"
      else
        # 端末かどうかで分岐しない。ブラウザが開けなければ gcloud がその場で理由を言って落ちる。
        browser_login || die '未ログインのままです。先に `gcloud auth login --update-adc` を済ませるか、GCP_AUTH_MODE=workforce と WORKFORCE_LOGIN_CONFIG を指定してください。'
      fi
      ;;
    existing)
      if ((dry_run)); then
        print_command gcloud auth list --filter=status:ACTIVE --format='value(account)'
        print_command gcloud auth application-default print-access-token
      else
        gcloud_session_ready || die '有効な gcloud アカウントか ADC がありません。GCP_AUTH_MODE=browser または workforce を指定してください。'
      fi
      ;;
    browser)
      browser_login
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

# 選ばせずに、このアカウントから見えているものを使う。1件しか無いのが普通で、
# 複数ある場合も既定を決めて進み、違うものを使いたい人には BILLING_ACCOUNT_ID を案内する。
choose_billing_account() {
  [[ -n ${BILLING_ACCOUNT_ID:-} ]] && return 0
  ((dry_run)) && die 'dry-run で新規作成を表示するには BILLING_ACCOUNT_ID を指定してください。'
  local ids count
  ids=$(open_billing_account_ids)
  if [[ -z "$ids" ]]; then
    # 無いものは待っても現れない。作り方を出して、作れたら同じコマンドを実行してもらう。
    guide_billing_account_creation
    die '使える請求先アカウントが1件も見えません。' \
      '上のページで作成するか、管理者から roles/billing.user をもらってから、同じコマンドを実行し直してください。' \
      '会社の請求先アカウントを使う場合は BILLING_ACCOUNT_ID=XXXXXX-XXXXXX-XXXXXX を指定してください。'
  fi

  count=$(printf '%s\n' "$ids" | wc -l | tr -d ' ')
  BILLING_ACCOUNT_ID=$(printf '%s\n' "$ids" | head -n 1)
  if ((count == 1)); then
    say "請求先アカウント $BILLING_ACCOUNT_ID を使用します。"
    return 0
  fi
  say "請求先アカウントが $count 件あります。先頭の $BILLING_ACCOUNT_ID を使用します。"
  gcloud billing accounts list --filter=open=true --format='table(name.basename(),displayName)'
  warn "別のものを使う場合は BILLING_ACCOUNT_ID=<上の表の ID> を指定して実行し直してください。"
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

  # 人にコンソールを開かせる前に、同じことを API でやってみる。
  # 権限があれば数秒で済み、無ければ下の手順を出す。どちらでも人を待たない。
  if [[ ${AUTO_FIX_ORG_POLICY:-1} == 1 ]] && override_domain_restricted_sharing; then
    say "$PROJECT_ID に iam.allowedPolicyMemberDomains の例外を追加しました。反映まで数分かかることがあります。"
    return 0
  fi

  manual_step '組織ポリシー「ドメインの制限された共有」に例外を追加する' \
    'iam.allowedPolicyMemberDomains が許可ドメインを列挙しています。' \
    'このままだと allUsers への公開が拒否され、demo の apply が' \
    '"One or more users named in the policy do not belong to a permitted customer" で落ちます。' \
    'スクリプトから例外を追加しようとしましたが、権限が足りず書き込めませんでした。' \
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

# プロジェクト単位の上書きだけを書く。親（組織やフォルダ）のポリシーには触らない。
override_domain_restricted_sharing() {
  local policy_file applied=0
  policy_file="${TMPDIR:-/tmp}/agent-xaa-orgpolicy-$PROJECT_ID-$$.yaml"
  {
    printf 'name: projects/%s/policies/iam.allowedPolicyMemberDomains\n' "$PROJECT_ID"
    printf 'spec:\n  rules:\n    - allowAll: true\n'
  } >"$policy_file"
  say "組織ポリシーの例外を $PROJECT_ID へ追加します。"
  print_command gcloud org-policies set-policy "$policy_file" --project="$PROJECT_ID"
  gcloud org-policies set-policy "$policy_file" --project="$PROJECT_ID" >/dev/null 2>&1 && applied=1
  rm -f -- "$policy_file"
  ((applied))
}

configure_project() {
  phase "GCP プロジェクト $PROJECT_ID を確認します。"
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
    if ((dry_run)); then
      print_command gcloud projects create "$PROJECT_ID" --name="$PROJECT_NAME" "${parent[@]}"
    else
      print_command gcloud projects create "$PROJECT_ID" --name="$PROJECT_NAME" "${parent[@]}"
      gcloud projects create "$PROJECT_ID" --name="$PROJECT_NAME" "${parent[@]}" || {
        manual_step 'プロジェクトを作成できませんでした' \
          'よくある原因は次の2つです。' \
          "  1. project ID は世界中で一意です。$PROJECT_ID が他の人に使われている場合は、" \
          '     PROJECT_ID=<別の名前> を指定して実行し直してください。' \
          '  2. 組織に属するアカウントでは、プロジェクトの作成権限（roles/resourcemanager.projectCreator）が' \
          '     要ります。管理者に付与を依頼するか、作成済みのプロジェクトの ID を PROJECT_ID に指定してください。' \
          '     https://cloud.google.com/resource-manager/docs/creating-managing-projects?hl=ja'
        die 'gcloud projects create が失敗しました。'
      }
    fi
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

# 何を作るのかは見せるが、答えは待たない。取り消したい人は Ctrl+C で止められるし、
# 中身を先に見たい人には --dry-run がある。ここで入力を求めると、
# 「実行して席を外す」という all のいちばん普通の使い方ができなくなる。
announce_mutations() {
  ((dry_run)) && return
  printf '\n対象 project: %s\nregion: %s\nimage tag: %s\ndemo tfvars: %s\n' "$PROJECT_ID" "$REGION" "$IMAGE_TAG" "$DEMO_TFVARS"
  printf 'ここから先は GCP に課金対象のリソースを作ります。初回は 30〜60 分かかります。\n'
  printf '費用の目安は放置で月額約 $0.5、1日動かして $1.1〜1.5 です（tasks/README.md の DEC-COST-01）。\n'
  printf 'demo destroy 後も state bucket、KMS、Artifact Registry などが残ります。\n'
  printf '中止する場合はいま Ctrl+C を押してください。作るものだけを見る場合は --dry-run を付けます。\n'
}

terraform_plan_apply() {
  local directory=$1 label=$2
  shift 2
  local plan_file="${TMPDIR:-/tmp}/agent-xaa-${label}-${PROJECT_ID}-$$.tfplan"
  local apply_log="${plan_file}.apply.log"
  local attempt=1 max_attempts=4 retry_delay_seconds=65

  if ((dry_run)); then
    run "${tf_command[@]}" -chdir="$directory" plan -input=false -out="$plan_file" "$@"
    run "${tf_command[@]}" -chdir="$directory" apply -input=false -parallelism=4 "$plan_file"
    return
  fi

  while ((attempt <= max_attempts)); do
    run "${tf_command[@]}" -chdir="$directory" plan -input=false -out="$plan_file" "$@"
    print_command "${tf_command[@]}" -chdir="$directory" apply -input=false -parallelism=4 "$plan_file"
    if "${tf_command[@]}" -chdir="$directory" apply -input=false -parallelism=4 "$plan_file" 2>&1 | tee "$apply_log"; then
      rm -f -- "$plan_file" "$apply_log"
      return 0
    fi

    if ! grep -Fq 'Service accounts created per minute per project' "$apply_log" \
      || ((attempt == max_attempts)); then
      rm -f -- "$apply_log"
      return 1
    fi

    warn "Service Account 作成の分間 quota に達しました。${retry_delay_seconds} 秒後に state を反映した plan で再開します（${attempt}/${max_attempts}）。"
    rm -f -- "$plan_file" "$apply_log"
    sleep "$retry_delay_seconds"
    attempt=$((attempt + 1))
  done
}

apply_bootstrap_and_shared() {
  phase 'Terraform state bucket を用意します。'
  # bootstrap keeps its state on the machine that ran it, so a second run from another
  # clone cannot tell from state that the bucket exists; GCP is asked instead.
  if ((!dry_run)) && gcloud storage buckets describe "gs://$PROJECT_ID-tfstate" >/dev/null 2>&1; then
    say "gs://$PROJECT_ID-tfstate は既にあるため作成を省きます。"
  else
    run "${tf_command[@]}" -chdir=infra/bootstrap init -input=false -lockfile=readonly
    terraform_plan_apply infra/bootstrap bootstrap \
      -var="project_id=$PROJECT_ID" -var="region=$REGION"
  fi

  say '共有リソースを作成します。'
  run "${tf_command[@]}" -chdir=infra/envs/shared init -input=false -lockfile=readonly -reconfigure \
    -backend-config="bucket=$PROJECT_ID-tfstate"
  # GCP never deletes KMS key rings or keys. After a destroy-all the project still holds
  # them while the state does not, and creating them again answers 409; adopt them first.
  say '削除できない KMS リソースが残っていないかを確認します。残っていれば1件ずつ state へ取り込みます。'
  run env PROJECT_ID="$PROJECT_ID" REGION="$REGION" TF="${tf_command[*]}" bash scripts/adopt-existing-kms.sh
  terraform_plan_apply infra/envs/shared shared \
    -var="project_id=$PROJECT_ID" -var="region=$REGION" \
    -var="audit_views_enabled=$(audit_views_enabled)"
}

# The saved detections read the table Cloud Logging creates from the first Cloud Run
# stdout line, which on a new project is long after this apply. GCP is asked rather than
# a flag remembered, so the answer is false exactly once — on the deploy that has not run
# a service yet — and a later run cannot delete the views an earlier one created.
audit_views_enabled() {
  if ((dry_run)); then
    printf 'false'
    return
  fi
  PROJECT_ID="$PROJECT_ID" bash scripts/audit-log-table.sh
}

# Applied last, and separately, for the reason above: by now the services are serving and
# both jobs have run, so the table the five views read exists or is seconds away.
apply_audit_views() {
  phase '保存済み検知 SQL を BigQuery View として作成します。'
  if ((dry_run)); then
    print_command bash scripts/audit-log-table.sh 300
    print_command "${tf_command[@]}" -chdir=infra/envs/shared apply -input=false \
      -var="project_id=$PROJECT_ID" -var="region=$REGION" -var=audit_views_enabled=true
    return
  fi
  printf '  Log Sink の宛先テーブル security_audit.run_googleapis_com_stdout を待ちます（最大5分） ' >&2
  if [[ $(PROJECT_ID="$PROJECT_ID" bash scripts/audit-log-table.sh 300) != true ]]; then
    warn 'Log Sink の宛先テーブルがまだ無いため、検知 View を作成していません。デプロイ自体は成功しています。'
    printf '  数分おいて次を実行すると作成されます: PROJECT_ID=%s REGION=%s make audit-views\n' "$PROJECT_ID" "$REGION" >&2
    return 0
  fi
  terraform_plan_apply infra/envs/shared audit-views \
    -var="project_id=$PROJECT_ID" -var="region=$REGION" -var="audit_views_enabled=true"
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
    '       作成すると client ID と client secret が表示されます。' \
    '       この2つは GOOGLE_OAUTH_CLIENT_ID と GOOGLE_OAUTH_CLIENT_SECRET_FILE で渡します。' \
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
  # 値は環境から受け取る。端末から読むと、その1行のために実行全体が人を待つことになる。
  # ここへ来る前に preflight_runtime_inputs がどちらか片方の存在を確かめている。
  if [[ -n ${GOOGLE_OAUTH_CLIENT_SECRET_FILE:-} ]]; then
    [[ -f "$GOOGLE_OAUTH_CLIENT_SECRET_FILE" ]] || die "GOOGLE_OAUTH_CLIENT_SECRET_FILE ($GOOGLE_OAUTH_CLIENT_SECRET_FILE) が見つかりません。"
    run gcloud secrets versions add "$secret_name" --project="$PROJECT_ID" --data-file="$GOOGLE_OAUTH_CLIENT_SECRET_FILE"
  elif ((dry_run)); then
    printf '+ printf %%s "$GOOGLE_OAUTH_CLIENT_SECRET" | gcloud secrets versions add %q --project=%q --data-file=-  # value redacted\n' "$secret_name" "$PROJECT_ID"
  elif [[ -n ${GOOGLE_OAUTH_CLIENT_SECRET:-} ]]; then
    say "$secret_name を GOOGLE_OAUTH_CLIENT_SECRET から登録します。値は表示しません。"
    printf '%s' "$GOOGLE_OAUTH_CLIENT_SECRET" | gcloud secrets versions add "$secret_name" --project="$PROJECT_ID" --data-file=- >/dev/null
  else
    die 'Google OAuth client secret の version がありません。' \
      'GOOGLE_OAUTH_CLIENT_SECRET_FILE=<secret を書いたファイル> か GOOGLE_OAUTH_CLIENT_SECRET=<secret> を指定してください。'
  fi
}

# The Bridge reads the connector's secret_name from Secret Manager on every call, and
# the stub SaaS checks one fixed client secret (apps/stub-saas-op/src/index.ts). The value
# is a test constant that the stub's source already states, not a secret of this deployment.
add_stub_bridge_secret_version() {
  local secret_name=stub-bridge-client-secret
  if ((!dry_run)) && [[ ${ROTATE_INTERNAL_SECRETS:-0} != 1 ]] && secret_has_enabled_version "$secret_name"; then
    say "$secret_name には有効な version があるため再利用します。"
    return
  fi
  say "$secret_name に stub SaaS が受け付ける固定の client secret を登録します。"
  if ((dry_run)); then
    print_command gcloud secrets versions add "$secret_name" --project="$PROJECT_ID" --data-file=-
  else
    printf '%s' stub-bridge-secret | gcloud secrets versions add "$secret_name" --project="$PROJECT_ID" --data-file=- >/dev/null
  fi
}

# The seed writes the Google connector definition with this id (apps/seed/src/connector-definitions.ts).
# Only the id: the secret is the version added above.
require_google_oauth_client_id() {
  [[ -n ${GOOGLE_OAUTH_CLIENT_ID:-} ]] && return 0
  ((dry_run)) && { GOOGLE_OAUTH_CLIENT_ID='<google-oauth-client-id>'; return 0; }
  die 'SAAS_CONNECTOR_MODE=google では GOOGLE_OAUTH_CLIENT_ID が必要です。' \
    "client ID は https://console.cloud.google.com/auth/clients?project=$PROJECT_ID で確認できます。" \
    'GOOGLE_OAUTH_CLIENT_ID=<xxxx>.apps.googleusercontent.com を指定して実行し直してください。'
}

provision_secret_values() {
  phase 'アプリの Secret version を用意します。'
  add_generated_secret_version human-idp-automation-client-secret
  add_generated_secret_version human-idp-agent-platform-client-secret
  if [[ "$ENABLE_GOOGLE_BRIDGE" == true ]]; then
    if [[ "$SAAS_CONNECTOR_MODE" == google ]]; then
      add_google_oauth_secret_version
      require_google_oauth_client_id
    else
      add_stub_bridge_secret_version
    fi
  fi
}

build_and_push_images() {
  phase 'コンテナイメージをビルドして Artifact Registry へ push します。'
  # worktree が綺麗かどうかは preflight_runtime_inputs が実行前に見ている。
  # ここまで来てから止めると、その時点で共有リソースの apply が終わってしまっている。
  local registry="$REGION-docker.pkg.dev/$PROJECT_ID/xaa"
  run gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet
  say '共有のビルド段を1回だけ作り、そのあと 17 個のイメージを並列に build と push します。アプリごとの進み具合は build-images 自身が表示します。'
  run env REGISTRY="$registry" IMAGE_TAG="$IMAGE_TAG" bash scripts/build-images.sh
}

apply_demo() {
  phase 'Cloud Run、Firestore、Pub/Sub、Scheduler と IAM を apply します。'
  run "${tf_command[@]}" -chdir=infra/envs/demo init -input=false -lockfile=readonly -reconfigure \
    -backend-config="bucket=$PROJECT_ID-tfstate"
  terraform_plan_apply infra/envs/demo demo \
    -var-file="../../../$DEMO_TFVARS" \
    -var="project_id=$PROJECT_ID" -var="region=$REGION" -var="image_tag=$IMAGE_TAG" \
    -var="enable_google_bridge=$ENABLE_GOOGLE_BRIDGE" -var="saas_connector_mode=$SAAS_CONNECTOR_MODE" \
    -var="google_oauth_client_id=${GOOGLE_OAUTH_CLIENT_ID:-}"
}

wait_for_services() {
  phase 'Cloud Run Service の Ready 状態を待ちます。'
  local -a services=(human-idp automation-app authorization provisioner lifecycle shared-agent-op agent-op-callback security-detection resource-finance-as resource-finance-api resource-docs-as resource-docs-api)
  if [[ "$ENABLE_GOOGLE_BRIDGE" == true ]]; then
    services+=(google-bridge google-bridge-callback)
    [[ "$SAAS_CONNECTOR_MODE" != stub ]] || services+=(stub-saas-op stub-saas-api)
  fi
  say "${#services[@]} 個の Service を確認します。1件あたり最大5分待ちます。"
  local service index=0 ready attempt
  for service in "${services[@]}"; do
    index=$((index + 1))
    if ((dry_run)); then
      print_command gcloud run services describe "$service" --project="$PROJECT_ID" --region="$REGION" --format=json
      continue
    fi
    printf '  [%d/%d] %s ' "$index" "${#services[@]}" "$service"
    ready=false
    for attempt in {1..60}; do
      if gcloud run services describe "$service" --project="$PROJECT_ID" --region="$REGION" --format=json \
        | jq -e '.status.conditions[]? | select(.type=="Ready" and .status=="True")' >/dev/null; then
        ready=true
        break
      fi
      printf '.'
      ((attempt < 60)) || break
      sleep 5
    done
    if [[ "$ready" == true ]]; then
      printf ' Ready（経過 %s）\n' "$(elapsed)"
    else
      printf ' NG\n'
      die "$service が Ready になりません。gcloud run services logs read $service で確認してください。"
    fi
  done
  verify_automation_login_registration
}

# Cloud Run が Ready でも、Automation App が要求する scope と Human IdP の
# client allowlist が食い違っていれば、ブラウザは callback の invalid_scope へ
# 戻される。実際の2段の redirect をたどり、ログイン画面へ進めるところまでを
# デプロイの完了条件にする。
verify_automation_login_registration() {
  ((login_registration_verified == 0)) || return 0
  say 'Automation App の OIDC client と scope 登録を検証します。'

  if ((dry_run)); then
    print_command curl -fsS -o /dev/null --max-redirs 0 -w '%{redirect_url}' \
      "https://automation-app-<project-number>.$REGION.run.app/login"
    print_command curl -fsS -o /dev/null --max-redirs 0 -w '%{redirect_url}' \
      'https://<issuer>/authorize?<automation-app-login-request>'
    login_registration_verified=1
    return 0
  fi

  local urls automation_app_url authorization_url login_url
  urls=$("${tf_command[@]}" -chdir=infra/envs/demo output -json service_urls)
  automation_app_url=$(jq -er '."automation-app"' <<<"$urls")
  authorization_url=$(curl -fsS -o /dev/null --max-redirs 0 -w '%{redirect_url}' \
    "$automation_app_url/login")

  [[ "$authorization_url" == *'/authorize?'* ]] || die \
    'Automation App の /login が Human IdP の認可エンドポイントを返しません。' \
    "redirect: ${authorization_url:-<empty>}"
  [[ "$authorization_url" == *'scope=openid+profile'* || "$authorization_url" == *'scope=openid%20profile'* ]] || die \
    'Automation App のログイン要求が登録対象の openid profile になっていません。' \
    "redirect: $authorization_url"

  login_url=$(curl -fsS -o /dev/null --max-redirs 0 -w '%{redirect_url}' "$authorization_url")
  if [[ "$login_url" == *'error=invalid_scope'* ]]; then
    die 'Human IdP で Automation App の profile scope が登録されていません。' \
      'apps/human-idp/src/config/scopes.ts を含む Human IdP image を配備し直してください。'
  fi
  [[ "$login_url" == *'/login?transaction_id='* ]] || die \
    'Human IdP が Automation App の認可要求をログイン画面へ進めません。' \
    "redirect: ${login_url:-<empty>}"

  login_registration_verified=1
  say 'openid profile は Automation App client に登録済みです。'
}

bootstrap_sso_and_seed() {
  phase 'Human IdP の SSO 署名鍵を初期化します。'
  # The Human IdP generates the key on its first request (apps/human-idp/src/keys/self-bootstrap.ts),
  # and its own JWKS lives at the OIDC well-known path; /jwks.json is the aggregate on GCS,
  # which does not exist until jwks-publish runs below.
  local issuer jwks_url attempt jwks_ready
  if ((dry_run)); then
    issuer="https://<human-idp-url>"
    print_command curl -fsS "$issuer/.well-known/jwks.json"
    print_command gcloud storage ls "gs://$PROJECT_ID-platform-config/sso-signing/current.json"
  else
    issuer=$("${tf_command[@]}" -chdir=infra/envs/demo output -json platform_endpoints | jq -r .issuer)
    jwks_url="$issuer/.well-known/jwks.json"
    printf '  %s の鍵を待ちます ' "$jwks_url"
    jwks_ready=false
    for attempt in {1..24}; do
      if curl -fsS "$jwks_url" 2>/dev/null | jq -e '.keys | length >= 1' >/dev/null 2>&1; then
        jwks_ready=true
        break
      fi
      printf '.'
      ((attempt < 24)) || break
      sleep 5
    done
    if [[ "$jwks_ready" == true ]]; then
      printf ' OK（経過 %s）\n' "$(elapsed)"
    else
      printf ' NG\n'
      die "$jwks_url が鍵を返しません。gcloud run services logs read human-idp --project=$PROJECT_ID --region=$REGION で確認してください。"
    fi
    gcloud storage ls "gs://$PROJECT_ID-platform-config/sso-signing/current.json" >/dev/null
    say 'SSO 秘密鍵は KMS で包まれたオブジェクトとして存在します。平文は取得しません。'
  fi

  say '共有 JWKS を集約してから定義データを投入します。'
  run gcloud run jobs execute jwks-publish --project="$PROJECT_ID" --region="$REGION" --wait
  run gcloud run jobs execute seed --project="$PROJECT_ID" --region="$REGION" --wait
}

verify_deployment() {
  phase 'IAM 到達性と権限を検証します。'
  verify_automation_login_registration
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
  phase "ログインユーザー $DEMO_LOGIN_USER への Human Permission 付与を確認します。"
  if [[ "$GRANT_DEMO_PERMISSIONS" != 1 ]]; then
    warn 'デモ用 Human Permission の付与を省きます。ログインしても権限は空のままです。'
    return 0
  fi
  # Bridge を配備していないときに calendar を付けても、seed が対応する Tool を落とすため
  # Capability だけが宙に浮く。配備した分だけ付ける。
  local -a capabilities=(document.read document.write finance.payment.read finance.payment.approve)
  [[ "$ENABLE_GOOGLE_BRIDGE" == true ]] && capabilities+=(calendar.event.read)
  if ((!dry_run)); then
    [[ -d node_modules ]] || run "${pnpm_command[@]}" install --frozen-lockfile
    # perm:set は dist を実行する。依存パッケージも一緒に組み上がる filter を使う。
    run "${pnpm_command[@]}" --filter '@xaa/authorization...' build
  fi
  local capability
  for capability in "${capabilities[@]}"; do
    run env GOOGLE_CLOUD_PROJECT="$PROJECT_ID" FIRESTORE_DATABASE=xaa-db STORE_MODE=gcp PUBSUB_MODE=gcp \
      "${pnpm_command[@]}" perm:set "$DEMO_LOGIN_USER" "$capability" grant
  done
}

print_next_steps() {
  phase 'デプロイ後の使い方を表示します。'
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

  local -a bridge_lines=()
  if [[ "$ENABLE_GOOGLE_BRIDGE" == true ]]; then
    if [[ "$SAAS_CONNECTOR_MODE" == stub ]]; then
      bridge_lines=(
        '' \
        '  Bridge（stub）: カレンダーを読む自動化を承認すると、Provisioner が同意 URL を返します。' \
        '    stub SaaS はログイン画面を持たず、開くだけで同意が完了します。' \
        ''
      )
    else
      bridge_lines=(
        '' \
        '  Bridge（Google）: カレンダーを読む自動化を承認すると、Provisioner が Google の同意 URL を返します。' \
        '    OAuth client のテストユーザーに登録した Google アカウントで同意してください。' \
        '    Google Calendar を呼ぶ Tool は catalog に定義していないため、同意までが動作範囲です（infra/README.md）。' \
        ''
      )
    fi
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
    "${bridge_lines[@]}" \
    "  Cloud Run:  https://console.cloud.google.com/run?project=$PROJECT_ID" \
    "  Firestore:  https://console.cloud.google.com/firestore/databases/xaa-db/data?project=$PROJECT_ID" \
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
  wait_for_verify_bindings
}

# A new IAM binding takes up to a couple of minutes to take effect. Verifying before it
# does reports every edge as unreachable, which reads like a broken deployment.
wait_for_verify_bindings() {
  ((${#temporary_verify_bindings[@]})) || return 0
  say "追加した ${#temporary_verify_bindings[@]} 件の binding が有効になるのを待ちます。1件あたり最大3分待ちます。"
  local entry service_account principal attempt ready
  for entry in "${temporary_verify_bindings[@]}"; do
    IFS=$'\t' read -r service_account principal <<<"$entry"
    printf '  %s ' "$service_account"
    ready=false
    for attempt in {1..36}; do
      if gcloud auth print-identity-token --project="$PROJECT_ID" \
        --impersonate-service-account="$service_account" --audiences="https://$PROJECT_ID.invalid" >/dev/null 2>&1; then
        ready=true
        break
      fi
      printf '.'
      ((attempt < 36)) || break
      sleep 5
    done
    if [[ "$ready" == true ]]; then
      printf ' OK（経過 %s）\n' "$(elapsed)"
    else
      printf ' NG\n'
      die "$service_account の偽装が有効になりません。数分待ってから verify を実行し直してください。"
    fi
  done
}

deploy() {
  apply_bootstrap_and_shared
  provision_secret_values
  build_and_push_images
  apply_demo
  wait_for_services
  bootstrap_sso_and_seed
  grant_demo_permissions
  apply_audit_views
}

doctor
case "$command_name" in
  doctor) ;;
  auth) authenticate ;;
  project) authenticate; configure_project ;;
  deploy) quality_gate; authenticate; announce_mutations; configure_project; deploy; print_next_steps ;;
  verify) authenticate; verify_deployment; print_next_steps ;;
  all) quality_gate; authenticate; announce_mutations; configure_project; deploy; verify_deployment; print_next_steps ;;
esac
