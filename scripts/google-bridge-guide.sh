#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Google Bridge を、本物の Google API を実際に叩けるところまで設定するための案内である。
#
# docs/google-bridge-setup.md は同じ手順を文章で書いている。文章で足りなかったのは、
# 貼り付ける値が project number とリージョンと connector id から決まること、
# そして貼り間違えても Google の同意画面までは進んでしまうことである。
# redirect URI の1文字違いは `redirect_uri_mismatch` として同意の直前に出るが、
# connector id の違いは同意が済んだあとの callback で `invalid_target` になり、
# 画面には「認可を完了できませんでした」だけが出る。どちらも、貼る前に確かめれば起きない。
#
# そこでこのスクリプトは、人が手で行うしかない4ページについては貼り付ける値を確定して見せ、
# 機械で確かめられることは全部確かめる。Google Cloud Console の同意画面と OAuth client は
# API から作れないため、そこだけは手で行う。
#
# deploy-gcp-guide.sh と同じく、入力待ちで止まることはない。
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
export TF_IN_AUTOMATION=1
export TF_INPUT=0
exec </dev/null

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)
cd "$repo_root"

command_name=all
dry_run=0

say() { printf '\n[google-bridge] %s\n' "$*"; }
warn() { printf '[google-bridge] WARNING: %s\n' "$*" >&2; }
ok() { printf '[google-bridge] ok / %s\n' "$*"; }
fail() { printf '[google-bridge] NG / %s\n' "$*" >&2; verify_status=1; }

die() {
  printf '[google-bridge] ERROR: %s\n' "$1" >&2
  shift
  local line
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit 1
}

phase() {
  printf '\n════════════════════════════════════════════════════════════════\n'
  printf '[google-bridge] %s\n' "$*"
  printf '════════════════════════════════════════════════════════════════\n'
}

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

print_command() { printf '+'; printf ' %q' "$@"; printf '\n'; }
run() { print_command "$@"; ((dry_run)) || "$@"; }

usage() {
  cat <<'USAGE'
Google Bridge を、本物の Google API を実際に叩けるところまで設定します。

Google Cloud Console の同意画面と OAuth client は API から作れないので、その4ページだけは
手で設定します。このスクリプトは貼り付ける値を確定して見せ、それ以外は自動で行い、
最後に「Google 経路が通る状態か」を項目ごとに確かめます。

Usage:
  scripts/google-bridge-guide.sh [all|doctor|enable|client|deploy|verify] [options]

  all      doctor → enable → client → deploy → verify（既定）
  doctor   手元のツールと GCP の前提だけを確認する
  enable   Google 側の API を有効にする。Console にスコープが出るようになる
  client   OAuth client の4ページと、貼り付ける redirect URI を出す
  deploy   google モードで scripts/deploy-gcp-guide.sh all を呼ぶ
  verify   配備済みの環境へ、Google 経路が通る状態かを訊く
  constants このスクリプトがリポジトリから読んでいる値を出す。GCP へは触らない

Options:
  --dry-run    外部状態を変更せず、実行予定のコマンドを表示する
  -h, --help   この説明を表示する

環境変数:
  PROJECT_ID                      対象の GCP project ID。省略時は gcloud config の project
  REGION                          既定値は asia-northeast1
  GOOGLE_OAUTH_CLIENT_ID          Console で作った client ID。deploy と verify で使う
  GOOGLE_OAUTH_CLIENT_SECRET_FILE client secret を書いたファイル。deploy で使う
  GOOGLE_CONNECTOR_ID             redirect URI に入る connector id。既定値はリポジトリの値
  FIRESTORE_DATABASE              既定値は xaa-db
  TF                              terraform の実行コマンド。既定値は terraform

はじめから通す例:

  PROJECT_ID=<project-id> scripts/google-bridge-guide.sh doctor
  PROJECT_ID=<project-id> scripts/google-bridge-guide.sh enable
  PROJECT_ID=<project-id> scripts/google-bridge-guide.sh client   # 表示された4ページを設定する
  PROJECT_ID=<project-id> \
    GOOGLE_OAUTH_CLIENT_ID=<id>.apps.googleusercontent.com \
    GOOGLE_OAUTH_CLIENT_SECRET_FILE=/secure/path/secret.txt \
    scripts/google-bridge-guide.sh all
USAGE
}

while (($#)); do
  case "$1" in
    all|doctor|enable|client|deploy|verify|constants) command_name=$1 ;;
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "不明な引数です: $1" ;;
  esac
  shift
done

REGION=${REGION:-asia-northeast1}
FIRESTORE_DATABASE=${FIRESTORE_DATABASE:-xaa-db}
read -r -a tf_command <<<"${TF:-terraform}"
demo_dir=infra/envs/demo
verify_status=0

# 定数はリポジトリの実装から読む。ここへ書き写すと、写した日から実装とずれ始め、
# ずれたことは Google の同意画面か Tool 呼び出しでしか分からない。
constant_from() {
  local value
  value=$(sed -n "s/^.*\\b$2 = '\\([^']*\\)'.*$/\\1/p" "$1" | head -1)
  [[ -n "$value" ]] || die "$1 から $2 を読めませんでした。" 'リポジトリが壊れているか、定数の名前が変わっています。'
  printf '%s' "$value"
}

CONNECTOR_SOURCE=apps/seed/src/connector-definitions.ts
TOOL_SOURCE=apps/seed/src/bridged-tool.ts
TOOL_YAML=infra/seed/tools/stub.calendar.events.list.yaml

GOOGLE_SCOPE=$(constant_from "$CONNECTOR_SOURCE" GOOGLE_CALENDAR_READONLY)
GOOGLE_PATH=$(constant_from "$TOOL_SOURCE" GOOGLE_CALENDAR_EVENTS_PATH)
DEFAULT_CONNECTOR_ID=$(constant_from "$CONNECTOR_SOURCE" BRIDGED_CONNECTOR_ID)
GOOGLE_CONNECTOR_ID=${GOOGLE_CONNECTOR_ID:-$DEFAULT_CONNECTOR_ID}
# 同意で要求する、この platform 自身の scope 名。Bridge が scope_map で翻訳する手前の値。
PLATFORM_SCOPE=$(sed -n 's/^.*scope: \([a-z.]*\) *}.*$/\1/p' "$TOOL_YAML" | head -1)
# 有効にする Google の API。Terraform が同じものを宣言している（services-bridge.tf）。
GOOGLE_API=calendar-json.googleapis.com

resolve_project() {
  PROJECT_ID=${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}
  [[ -n "$PROJECT_ID" && "$PROJECT_ID" != '(unset)' ]] || die 'PROJECT_ID が要ります。' \
    '  PROJECT_ID=<project-id> scripts/google-bridge-guide.sh ' \
    '  または gcloud config set project <project-id> を先に実行してください。'
}

project_number() {
  gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)' 2>/dev/null || true
}

# 貼り付ける redirect URI。配備済みなら Terraform が出す実際のホスト名を使い、
# まだなら project number とリージョンから組み立てる。Cloud Run の既定ホスト名は
# この2つで決まるので、apply の前でも確定できる。
callback_base_url() {
  local urls deployed number
  urls=$("${tf_command[@]}" -chdir="$demo_dir" output -json service_urls 2>/dev/null) || urls=''
  if [[ -n "$urls" ]]; then
    deployed=$(jq -r '."google-bridge-callback" // empty' <<<"$urls" 2>/dev/null || true)
    [[ -n "$deployed" ]] && { printf '%s' "$deployed"; return 0; }
  fi
  number=$(project_number)
  [[ -n "$number" ]] || { printf 'https://google-bridge-callback-<project-number>.%s.run.app' "$REGION"; return 0; }
  printf 'https://google-bridge-callback-%s.%s.run.app' "$number" "$REGION"
}

redirect_uri() { printf '%s/%s/oauth/callback' "$(callback_base_url)" "$GOOGLE_CONNECTOR_ID"; }

do_doctor() {
  phase '前提を確認します'
  local missing=()
  local tool
  for tool in gcloud jq curl; do
    command -v "$tool" >/dev/null || missing+=("$tool")
  done
  ((${#missing[@]} == 0)) || die "次のコマンドが見つかりません: ${missing[*]}" \
    '  gcloud: https://cloud.google.com/sdk/docs/install' \
    '  jq / curl: OS のパッケージマネージャで入れてください。'
  ok "gcloud、jq、curl はあります"

  resolve_project
  if ((dry_run)); then
    ok "project は $PROJECT_ID（dry-run のため到達性は確認しません）"
    return 0
  fi
  gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1 || die "project $PROJECT_ID を読めません。" \
    '  gcloud auth login を実行してから、もう一度試してください。'
  ok "project $PROJECT_ID を読めます"

  local account
  account=$(gcloud config get-value account 2>/dev/null || true)
  [[ -n "$account" && "$account" != '(unset)' ]] && ok "ログイン中のアカウント: $account" \
    || warn 'gcloud にログインしていません。gcloud auth login を先に実行してください。'

  # 同意できるのはテストユーザーだけなので、Console でテストユーザーへ入れるのはこの人である。
  say "Google の同意画面のテストユーザーには、上のアカウントを追加してください。"
}

do_enable() {
  phase "Google の API を有効にします（$GOOGLE_API）"
  resolve_project
  # ここで有効にしておくと、Console のデータアクセス画面が Calendar のスコープを一覧に出す。
  # 有効化前は、追加したいスコープが検索しても出てこない。
  run gcloud services enable "$GOOGLE_API" --project="$PROJECT_ID"
  ok "$GOOGLE_API を有効にしました（Terraform も services-bridge.tf で同じものを宣言します）"
}

do_client() {
  phase 'OAuth client を作ります（この4ページだけは手で設定します）'
  resolve_project
  local uri
  uri=$(redirect_uri)
  manual_step 'Google Cloud Console の4ページを、上から順に設定する' \
    'ブランディングを保存するまで、残り3ページは開いても設定できません。' \
    '' \
    "  1. ブランディング  https://console.cloud.google.com/auth/branding?project=$PROJECT_ID" \
    '       アプリ名、ユーザーサポートメール、デベロッパーの連絡先情報を入れて保存します。' \
    '' \
    "  2. 対象            https://console.cloud.google.com/auth/audience?project=$PROJECT_ID" \
    '       ユーザーの種類に「外部」を選びます。' \
    '       テストユーザーへ、これから同意する自分の Google アカウントを追加します。' \
    '       追加を忘れると、同意画面まで進んだうえで access_denied になります。' \
    '' \
    "  3. データアクセス  https://console.cloud.google.com/auth/scopes?project=$PROJECT_ID" \
    '       次のスコープを追加します。' \
    "         $GOOGLE_SCOPE" \
    "       これは接続先定義の scope_map が「$PLATFORM_SCOPE」を翻訳した先の値です。" \
    '       違う値を入れると、同意画面が invalid_scope になります。' \
    '' \
    "  4. クライアント    https://console.cloud.google.com/auth/clients/create?project=$PROJECT_ID" \
    '       アプリケーションの種類に「ウェブ アプリケーション」を選びます。' \
    '       「承認済みのリダイレクト URI」へ、次の1行をそのまま貼り付けます。' \
    '' \
    "         $uri" \
    '' \
    '       作成すると client ID と client secret が表示されます。' \
    '       secret はこの1回しか表示されないので、その場でファイルへ保存してください。' \
    '' \
    '貼り付けた値が合っているかは、この先の deploy と verify が確かめます。' \
    "作成済みの client: https://console.cloud.google.com/auth/clients?project=$PROJECT_ID"

  if [[ "$uri" == *'<project-number>'* ]]; then
    warn 'project number を読めなかったため、redirect URI は形だけを出しています。'
    warn 'gcloud にログインしてから client を実行し直すと、貼り付けられる値になります。'
  fi
}

do_deploy() {
  phase 'google モードで配備します'
  resolve_project
  [[ -n ${GOOGLE_OAUTH_CLIENT_ID:-} ]] || die 'GOOGLE_OAUTH_CLIENT_ID が要ります。' \
    '  client サブコマンドで作った OAuth client の client ID を渡してください。' \
    "  一覧: https://console.cloud.google.com/auth/clients?project=$PROJECT_ID"
  [[ -n ${GOOGLE_OAUTH_CLIENT_SECRET_FILE:-} || -n ${GOOGLE_OAUTH_CLIENT_SECRET:-} ]] || \
    die 'client secret の渡し方が指定されていません。' \
      '  GOOGLE_OAUTH_CLIENT_SECRET_FILE=<secret を書いたファイル> を指定してください。' \
      '  値を直接渡す GOOGLE_OAUTH_CLIENT_SECRET もありますが、シェルの履歴に残ります。'

  # 配備そのものは既存の案内スクリプトが持っている。ここが行うのは、Bridge を有効にし、
  # 接続先を Google にする2つの変数を立てて、それを呼ぶことである。
  local -a deploy=(scripts/deploy-gcp-guide.sh all)
  ((dry_run)) && deploy+=(--dry-run)
  run env \
    PROJECT_ID="$PROJECT_ID" REGION="$REGION" \
    ENABLE_GOOGLE_BRIDGE=true SAAS_CONNECTOR_MODE=google \
    GOOGLE_CONNECTOR_ID="$GOOGLE_CONNECTOR_ID" \
    "${deploy[@]}"
}

# --- verify -----------------------------------------------------------------------
#
# 「同意までは通ったが Tool 呼び出しが空で返る」は、下のどの層が欠けても同じ見え方になる。
# 層ごとに直接訊いて、答えに層の名前を出す。

firestore_get() {
  local access_token=$1 path=$2
  curl -sS --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer $access_token" \
    "https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${FIRESTORE_DATABASE}/documents/${path}" || true
}

do_verify() {
  phase 'Google 経路が通る状態かを確かめます'
  resolve_project
  if ((dry_run)); then
    say 'dry-run では確認を行いません。'
    return 0
  fi

  # 1. API。無効なままだと、同意は通り Tool 呼び出しだけが 403 になる。
  local enabled_services
  enabled_services=$(gcloud services list --enabled --project="$PROJECT_ID" \
    --format='value(config.name)' 2>/dev/null || true)
  if grep -qx "$GOOGLE_API" <<<"$enabled_services"; then
    ok "$GOOGLE_API が有効です"
  else
    fail "$GOOGLE_API が有効ではありません。enable サブコマンドを実行してください"
  fi

  # 2. client secret。無いと Bridge の code 交換が invalid_client で落ちる。
  # 出力はパイプで受けず変数へ入れる。`... | read` は最初の1行で read が返り、
  # 上流が SIGPIPE で死ぬと pipefail がパイプライン全体を失敗にするため、
  # 「version はあるのに無いと報告する」が起こりうる。
  local secret_versions
  secret_versions=$(gcloud secrets versions list google-oauth-client-secret --project="$PROJECT_ID" \
    --filter='state=ENABLED' --format='value(name)' 2>/dev/null || true)
  if [[ -n "$secret_versions" ]]; then
    ok 'google-oauth-client-secret に有効な version があります'
  else
    fail 'google-oauth-client-secret に有効な version がありません。deploy サブコマンドを実行してください'
  fi

  local access_token
  access_token=$(gcloud auth print-access-token --project="$PROJECT_ID" 2>/dev/null || true)
  if [[ -z "$access_token" ]]; then
    fail 'アクセストークンを取得できないため、Firestore の行は確認していません'
  else
    verify_connector_definition "$access_token"
    verify_catalog_tool "$access_token"
  fi

  verify_redirect_uri

  if ((verify_status == 0)); then
    say '確認できた範囲では、Google の Calendar を読むところまで通る状態です。'
    say '画面から「今週の予定を読む」作業を書いて Agent を作り、同意して確かめてください。'
  else
    say '上の NG を直してから、もう一度 verify を実行してください。'
  fi
  return "$verify_status"
}

verify_connector_definition() {
  local access_token=$1 row
  row=$(firestore_get "$access_token" "connector_definitions/${GOOGLE_CONNECTOR_ID}")
  if ! jq -e '.fields' >/dev/null 2>&1 <<<"$row"; then
    fail "connector_definitions/${GOOGLE_CONNECTOR_ID} がありません。seed Job が走っていません（make seed）"
    return
  fi
  local token_endpoint client_id mapped
  token_endpoint=$(jq -r '.fields.token_endpoint.stringValue // empty' <<<"$row")
  client_id=$(jq -r '.fields.client_id.stringValue // empty' <<<"$row")
  mapped=$(jq -r --arg scope "$PLATFORM_SCOPE" '.fields.scope_map.mapValue.fields[$scope].stringValue // empty' <<<"$row")

  [[ "$token_endpoint" == https://oauth2.googleapis.com/* ]] \
    && ok '接続先定義は Google を向いています' \
    || fail "接続先定義の token_endpoint が Google ではありません（$token_endpoint）。SAAS_CONNECTOR_MODE=google で seed を流し直してください"

  [[ "$client_id" == *.apps.googleusercontent.com ]] \
    && ok "接続先定義の client ID は $client_id です" \
    || fail "接続先定義の client ID が Google のものに見えません（${client_id:-空}）"

  if [[ -n ${GOOGLE_OAUTH_CLIENT_ID:-} && "$client_id" != "$GOOGLE_OAUTH_CLIENT_ID" ]]; then
    fail "接続先定義の client ID が渡された GOOGLE_OAUTH_CLIENT_ID と違います。seed を流し直してください"
  fi

  [[ "$mapped" == "$GOOGLE_SCOPE" ]] \
    && ok "scope_map が $PLATFORM_SCOPE を $GOOGLE_SCOPE へ翻訳します" \
    || fail "scope_map が $PLATFORM_SCOPE を翻訳していません（${mapped:-無し}）。同意画面が invalid_scope になります"
}

# google モードで seed が走ったかどうかは、この1行が最も早く答える。
# stub の形のままなら、同意は通り、Tool 呼び出しだけが Google から 404 で返る。
verify_catalog_tool() {
  local access_token=$1 tool_id row path base
  tool_id=$(sed -n 's/^tool_id: *//p' "$TOOL_YAML" | head -1)
  row=$(firestore_get "$access_token" "catalog_tools/${tool_id}")
  if ! jq -e '.fields' >/dev/null 2>&1 <<<"$row"; then
    fail "catalog_tools/${tool_id} がありません。Bridge を有効にして seed を流してください"
    return
  fi
  path=$(jq -r '.fields.api.mapValue.fields.path.stringValue // empty' <<<"$row")
  base=$(jq -r '.fields.api.mapValue.fields.base_url.stringValue // empty' <<<"$row")
  [[ "$path" == "$GOOGLE_PATH" ]] \
    && ok "Tool は Google の $GOOGLE_PATH を呼びます" \
    || fail "Tool のパスが stub の形のままです（${path:-空}）。SAAS_CONNECTOR_MODE=google で seed を流し直してください"
  [[ "$base" == https://www.googleapis.com* ]] \
    && ok "Tool の宛先は $base です" \
    || fail "Tool の宛先が Google ではありません（${base:-空}）"
}

# 貼り付けた redirect URI は Google 側にしかないので、ここで確かめられるのは
# 「いま貼るべき値」がデプロイ後も同じかどうかである。callback のホスト名は
# project number から決まるため、apply の前後で変わることはない。
verify_redirect_uri() {
  local uri
  uri=$(redirect_uri)
  if [[ "$uri" == *'<project-number>'* ]]; then
    fail 'redirect URI を確定できません。gcloud にログインしてから実行してください'
    return
  fi
  ok "OAuth client に入っているべき redirect URI: $uri"
  say '上の1行が Google の client の「承認済みのリダイレクト URI」と一致していることを目で確かめてください。'
  say 'Google 側の設定は API から読めないため、ここだけは機械で確かめられません。'
}

# リポジトリから読んだ値をそのまま出す。GCP へ触らないので、手元でも CI でも走る。
# scripts/checks/google-bridge-guide.sh がこれを呼び、定数の名前が変わって
# このスクリプトが実装を読めなくなっていないかを確かめる。読めなくなったことは、
# それまで Google 側へ貼る値が黙って古くなる形でしか現れない。
do_constants() {
  printf 'connector_id\t%s\n' "$GOOGLE_CONNECTOR_ID"
  printf 'platform_scope\t%s\n' "$PLATFORM_SCOPE"
  printf 'google_scope\t%s\n' "$GOOGLE_SCOPE"
  printf 'google_path\t%s\n' "$GOOGLE_PATH"
  printf 'google_api\t%s\n' "$GOOGLE_API"
}

case "$command_name" in
  constants) do_constants ;;
  doctor) do_doctor ;;
  enable) do_doctor; do_enable ;;
  client) do_doctor; do_client ;;
  deploy) do_doctor; do_deploy ;;
  verify) do_doctor; do_verify ;;
  all)
    do_doctor
    do_enable
    do_client
    do_deploy
    do_verify
    ;;
esac
