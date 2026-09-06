#!/usr/bin/env bash
# scripts/google-bridge-guide.sh は、Google 側へ貼り付ける値を書き写さず、実装から読む。
# 書き写せばその日から実装とずれ始め、ずれたことは Google の同意画面か Tool 呼び出しでしか
# 分からない。読む以上、読めなくなったことは検出できなければならない。
#
# ここで確かめるのは2つである。スクリプトがいま実装を読めること、そして読んだ値が
# 「Google のもの」であることが形から言えること。値そのものを書くとこの検査が写しになるので、
# 一致ではなく形を見る。値の一致は apps/seed/test/bridged-tool.spec.ts が実装の側で見ている。
set -euo pipefail
cd "$(dirname "$0")/../.."

guide=scripts/google-bridge-guide.sh
[[ -x "$guide" ]] || { echo "google-bridge-guide: $guide が実行可能ではありません" >&2; exit 1; }

# GCP へは触らない部分模式。読めない定数があればここで die する。
constants=$("$guide" constants) || {
  echo 'google-bridge-guide: リポジトリから定数を読めません。名前が変わったか、実装が動きました' >&2
  exit 1
}

value_of() { awk -F'\t' -v key="$1" '$1 == key { print $2 }' <<<"$constants"; }

status=0
check() {
  local key=$1 pattern=$2 value
  value=$(value_of "$key")
  if [[ -z "$value" ]]; then
    echo "google-bridge-guide: $key を読めませんでした" >&2
    status=1
  elif [[ ! "$value" =~ $pattern ]]; then
    echo "google-bridge-guide: $key が想定の形ではありません: $value" >&2
    status=1
  fi
}

check connector_id '^[a-z0-9-]+$'
check platform_scope '^[a-z]+\.[a-z]+$'
# Google のスコープと API とパスは、Google のものだと形から分かる。
check google_scope '^https://www\.googleapis\.com/auth/'
check google_path '^/calendar/v[0-9]+/'
check google_api '\.googleapis\.com$'

# connector id は redirect URI の途中に入る。ここが実装と違うと、同意は済んだあとの
# callback が invalid_target になり、画面には「認可を完了できませんでした」だけが出る。
grep -Fq "$(value_of connector_id)" apps/seed/src/connector-definitions.ts || {
  echo 'google-bridge-guide: connector id が seed の実装に見当たりません' >&2
  status=1
}

[ "$status" -eq 0 ] && echo 'ok: the Google Bridge guide still reads its values from the implementation'
exit "$status"
