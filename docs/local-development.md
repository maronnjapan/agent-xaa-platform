# ローカルで動かす

GCP へ配備せず、手元のパソコン1台の上で基盤全体を動かす手順である。
Docker も要らず、データベースのインストールも要らない。
必要なのは Node.js 22 と pnpm だけである。

配備した基盤との違いは[7章](#7-配備した基盤との違い)にまとめてある。
画面の操作手順そのものは[サイトの使い方](./user-guide.md)と同じである。

## 1. 起動する

```bash
pnpm install --frozen-lockfile
pnpm local
```

`pnpm local` はワークスペースをビルドし、16 のサービスをこのプロセスの中で起動する。
起動が終わると、開く URL とログイン情報が表示される。

```
    Automation App     http://127.0.0.1:8080
    Analysis Console   http://127.0.0.1:8082
    Human IdP          http://127.0.0.1:8081

    Sign in as         testuser / password
    Model              fake (no model is called; set MODEL_PROVIDER to change that)
    Services           14 listening
    State              /path/to/agent-xaa-platform/.local/state
```

止めるときは Ctrl+C を押す。
書いた ToDo も、決めた権限も、作ったドキュメントも `.local/state` に残り、次の起動でそのまま出てくる（[5章](#5-状態を手元に残す)）。
[infra/seed](../infra/seed) の内容は、残っているものが何も無いときだけ書き込まれる。
初回は配備した基盤と同じ品揃えの状態から始まり、2回目からは前回の続きから始まる。

ポートは 8079 から 8096 までを使う。
すでに使っているポートがある場合は `LOCAL_PORT_OFFSET` でまとめてずらす。

```bash
LOCAL_PORT_OFFSET=100 pnpm local   # Automation App は http://127.0.0.1:8180 になる
```

## 2. どのサービスがどのポートか

| ポート | サービス | 役割 |
|---|---|---|
| 8079 | platform-config | 集約 JWK Set と endpoints.json。配備では Cloud Storage のバケット |
| 8080 | automation-app | ToDo を書き、Agent を作り、止める画面 |
| 8081 | human-idp | ログインと Access Token の発行元 |
| 8082 | analysis-console | 分析エージェントの判断を読む画面 |
| 8083 | authorization | 権限決定 |
| 8084 | provisioner | Agent の Provisioning |
| 8085 | lifecycle | Agent の停止と破棄 |
| 8086 | shared-agent-op | Shared Agent OP（ID-JAG の発行） |
| 8087 | agent-op-callback | Agent OP のコールバック面 |
| 8088 | security-detection | 異常検知 |
| 8089 / 8090 | resource-docs-as / api | Document Resource Server |
| 8091 / 8092 | resource-finance-as / api | Finance Resource Server |
| 8093 / 8094 | stub-saas-op / api | 疑似 SaaS（Bridge を有効にしたときだけ） |
| 8095 / 8096 | google-bridge / callback | OAuth Bridge（同上） |
| 8200〜 | dedicated-op-* | Full Isolation の Agent 専用 OP。Provisioning のたびに増える |

## 3. 実行モデルを選ぶ

既定では**モデルを呼ばない**（`MODEL_PROVIDER=fake`）。
ログイン、ToDo の作成、画面の表示までは動くが、Work Definition から Capability を推論する段階で何も返らないため、Agent Definition は提示されない。
最後まで通すにはモデルを1つ指定する。

Gemini に限定していない。
`MODEL_PROVIDER` で選び、モデル名は `MODEL_NAME` で渡す。

| `MODEL_PROVIDER` | 何を呼ぶか | 追加で必要なもの |
|---|---|---|
| `fake` | 何も呼ばない（既定） | なし |
| `cli` | 手元にインストール済みのコーディングエージェント | `claude` か `codex` が PATH にあること |
| `anthropic` | Anthropic（LangChain 経由） | `ANTHROPIC_API_KEY` |
| `openai` | OpenAI と OpenAI 互換のサーバ（LangChain 経由） | `OPENAI_API_KEY` |
| `vertex` | Vertex AI（配備時と同じ経路） | GCP の Application Default Credentials と `MODEL_NAME` |

`anthropic` と `openai` は [packages/xaa-model](../packages/xaa-model) の1つのクライアントであり、
プロバイダごとの差は「どの API を、どのキーで呼ぶか」の表1行だけである。
スキーマの渡し方は LangChain の `withStructuredOutput` が各プロバイダの持つ経路へ振り分ける
（Anthropic は Tool の `input_schema`、OpenAI は `response_format: json_schema`）。
`openai` は OpenAI 自身に限らず、Ollama・vLLM・LM Studio やその前段のゲートウェイなど
OpenAI 互換の口を持つものすべてに `OPENAI_BASE_URL` で向けられる。

Claude Code を使う場合はこうである。

```bash
MODEL_PROVIDER=cli MODEL_CLI=claude-code pnpm local
```

Codex を使う場合はこうである。

```bash
MODEL_PROVIDER=cli MODEL_CLI=codex pnpm local
```

API キーを使う場合はこうである。

```bash
MODEL_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... MODEL_NAME=claude-sonnet-5 pnpm local
MODEL_PROVIDER=openai OPENAI_API_KEY=sk-... MODEL_NAME=gpt-5 pnpm local
```

手元で動かしているモデルへ向ける場合は、OpenAI 互換の口を `OPENAI_BASE_URL` で指す。
`/v1` まで含めた URL を書く（OpenAI の SDK がそう読むためである）。
キーを要求しないサーバでも `OPENAI_API_KEY` には何か置く。

```bash
MODEL_PROVIDER=openai OPENAI_API_KEY=dummy \
  OPENAI_BASE_URL=http://127.0.0.1:11434/v1 MODEL_NAME=qwen3 pnpm local
```

どのプロバイダを選んでも、アプリケーション側は何も変わらない。
基盤の4つのアプリはいずれも `generateJson`（[packages/xaa-vertex](../packages/xaa-vertex)）を通してモデルへ問い、返るのは呼び出し側が渡した JSON Schema を満たす値か `null` のどちらかである。
`null` は「使える答えが返らなかった」を意味し、モデルが落ちても API キーが切れても文字化けしても同じ形になる。

パッケージが2つに分かれているのは、配備するものと配備しないものの境目である。
Vertex とフェイクは配備した基盤が呼ぶ経路なので [packages/xaa-vertex](../packages/xaa-vertex) にあり、コンテナに入る。
それ以外（LangChain 経由のプロバイダと、手元のコーディングエージェント）は [packages/xaa-model](../packages/xaa-model) にあり、どのイメージにも入らない。
選ぶのはローカル実行の合成点1か所で、`setDefaultModelClient` で全アプリに渡す。
コンテナへ `MODEL_PROVIDER=anthropic` を渡しても、そのコンテナは Gemini で代わりに答えたりはせず、届かないと言って止まる。

`cli` プロバイダについては、次の3点に注意する。

- プロンプトは標準入力から渡し、シェルを経由しない。
- 作業ディレクトリは一時ディレクトリであり、このリポジトリではない。エージェントの答えが編集にならないようにするためである。
- スキーマを渡すチャネルが無いため、スキーマはプロンプトに書いて渡し、標準出力から JSON を取り出す。取り出せなければ `null` になる。

コマンドと引数を自分で決めたい場合は `MODEL_CLI=custom` を使う。

```bash
MODEL_PROVIDER=cli MODEL_CLI=custom \
  MODEL_CLI_COMMAND=my-agent MODEL_CLI_ARGS='["--json","-"]' pnpm local
```

## 4. 設定できること

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `MODEL_PROVIDER` | `fake` | 3章 |
| `MODEL_NAME` | `VERTEX_MODEL` | モデル名 |
| `MODEL_CLI` | `claude-code` | `claude-code` / `codex` / `custom` |
| `MODEL_CLI_COMMAND` | プリセット依存 | `custom` のときのコマンド |
| `MODEL_CLI_ARGS` | プリセット依存 | JSON 配列で渡す引数 |
| `MODEL_CLI_TIMEOUT_MS` | `180000` | 1回の問い合わせの制限時間 |
| `ANTHROPIC_API_KEY` | なし | `MODEL_PROVIDER=anthropic` のときのキー |
| `ANTHROPIC_BASE_URL` | Anthropic の API | ゲートウェイなどへ向けるとき |
| `OPENAI_API_KEY` | なし | `MODEL_PROVIDER=openai` のときのキー |
| `OPENAI_BASE_URL` | OpenAI の API | OpenAI 互換のサーバへ向けるとき。`/v1` まで書く |
| `LOCAL_HOST` | `127.0.0.1` | 待ち受けるアドレス |
| `LOCAL_PORT_OFFSET` | `0` | 全ポートをまとめてずらす |
| `LOCAL_ENABLE_GOOGLE_BRIDGE` | `false` | OAuth Bridge と疑似 SaaS を起動する |
| `LOCAL_PERSIST` | `true` | 状態をディスクに残す。`false` で何も残さない（5章） |
| `LOCAL_STATE_DIR` | `.local/state` | 状態を置くディレクトリ。実行したディレクトリからの相対 |
| `LOCAL_SEED` | `auto` | `auto` は残っているものが無いときだけ seed を流す。`true` は毎回流し、`false` は流さない |
| `LOCAL_LIFECYCLE_TICK_MS` | `300000` | Lifecycle Manager の tick 間隔 |
| `LOCAL_EXECUTION_START_DELAY_MS` | `3000` | Agent Runtime の Execution が最初の推論を始めるまでの待ち |
| `LOCAL_QUIET` | `false` | バナーと構造化ログを出さない |
| `ADMIN_PRINCIPALS` | 空 | 管理画面に到達できるアカウント。空のときは誰も到達できない |
| `AGENT_MAX_LIFETIME_SECONDS` | `86400` | Agent の寿命の上限 |

`LOCAL_ENABLE_GOOGLE_BRIDGE=true` にすると `saas_connector_mode = "stub"` と同じ構成になり、疑似 SaaS を相手に Bridge 経由の Tool まで通る。
Google の OAuth client は要らない。
配備時の既定と同じく、既定では無効である（DEC-SCOPE-04）。

## 5. 状態を手元に残す

止めても消えない。
書いた ToDo、承認した Agent Definition、管理画面で足した権限、作ったドキュメント、ログインした Session は、既定で `.local/state` に残り、次の起動でそのまま読み直される。

残るのは3つである。

| ファイル | 中身 |
|---|---|
| `firestore.json` | Firestore の全行。ToDo も権限も Agent の台帳もここにある |
| `kms-master.key` | ローカル KMS が鍵を導出する秘密。これが変わると、前回暗号化したものは開けない |
| `platform-config/sso-signing/current.json` | Human IdP の SSO 署名鍵。配備時に非公開バケットへ置くものと同じ形で、同じ KMS 鍵で包んである |

3つとも必要である。
行だけ残しても、鍵が変われば Human IdP Connection は復号できず、署名鍵が変わればブラウザに残っている Access Token はどれも検証できない。
配備した基盤が Firestore・Cloud KMS・非公開バケットに分けて持っているものが、ここでは1つのディレクトリに入っている。
だからディレクトリは `0700`、ファイルは `0600` で作る。

最初からやり直すときは消す。
次の起動は初回と同じで、seed から始まる。

```bash
rm -rf .local/state                  # 前回までを捨てる
LOCAL_PERSIST=false pnpm local       # 今回の分を何も残さない
LOCAL_STATE_DIR=/tmp/xaa pnpm local  # 別の場所に置く
```

Agent の Client Credential の秘密鍵だけは、ここにも Firestore にも書かない（RULE-22）。

### seed をもう一度流す

[infra/seed](../infra/seed) は、残っているものが何も無いときだけ流れる。
seed が書く表（カタログ、Capability の分類、`human_permissions`、`delegatable_permissions`）は、流すたびに一度空にしてから書き直すからである。
毎回流すと、管理画面（`/admin`）で足した権限が起動のたびに消えることになる。

YAML を書き換えて反映したいときは、明示的に頼む。

```bash
LOCAL_SEED=true pnpm local
```

デモ用のドキュメントは「何日前に起きたか」を流した時刻から決めるため、流し直すと日付も now に寄せ直される。
何日も同じ状態を使い続けて、提案フォームが見る7日の窓から外れたときは、これで戻す。

### Agent は残らない

行は残るが、Agent は残らない。
Agent 自身の Client Credential の秘密鍵は、その Agent を動かしている Execution の環境の中にしか無く、`full_isolation` の Agent 専用 OP は、その Provisioning をしたプロセスの listener である。
どちらもプロセスと一緒に消えるので、台帳の行だけあっても、動く Agent にはならない。

そこで起動時に、前回から残っている Agent を Lifecycle Manager の Cleanup で終わらせる。
発行済みのトークンは revoke され、OP は発行を止め、台帳の行は監査ログを残して消える。
理由は EXPIRED である（QUARANTINE ではない。異常時の理由は本人の上流の Refresh Token まで revoke してしまい、他の Agent の接続も切れる）。
ToDo はそのまま残るので、画面から完了にすることも取り下げることもできる。
配備した基盤で Agent が寿命を迎えたときと、ToDo から見える姿は同じである。

## 6. 何が本物のまま動いているか

ローカルでも、基盤の判断はすべて配備時と同じコードが行う。
サービスはそれぞれ自分のポートで待ち受け、互いを URL で呼ぶ。

- ログインは Human IdP との本物の OAuth 往復である。ブラウザは4つの Audience 分の Authorization Code Flow を実際に歩き、Access Token は DPoP で鍵に紐づく。
- サービス間の呼び出しは Cloud Run と同じ ID Token を提示する。宛先ごとに Audience が異なる本物の RS256 トークンであり、受け取る側は署名も Audience も検証する。別のサービス向けのトークンでは開かない。
- ID-JAG は Agent OP が ES256 で署名し、Resource Authorization Server は集約 JWK Set から鍵を取ってきて検証する。
- Full Isolation の Agent には、専用の Agent OP・専用の署名鍵・専用の暗号鍵・専用の Service Account・専用の Job が本当に作られ、Lifecycle Manager が台帳の行に沿って本当に消す。作成と削除は配備時と同じ関数が行い、名前空間の境界（DEC-IAC-08）も同じように効く。
- Activity Event は Pub/Sub と同じ経路をたどる。Automation App の `/internal/activity/push` へ HTTP で配送され、受け取る側は配送元の ID Token を検証する。
- Security Detection は、各サービスが標準出力へ書いた構造化ログを購読する。配備時に Cloud Logging の Log Sink が担う経路を、共有ロガーの出力口が担っている。

実際に、Claude Code を実行モデルにしてローカルで通したときのログはこうなる。
Agent が ID-JAG を Document Resource AS で Access Token に引き換え、その Token で Document Resource API を6回呼んでいる。

```
resource-docs-as   resource_as.redeem   received_kid=op-shared-1 id_jag_iss=http://127.0.0.1:8081 id_jag_sub=testuser
resource-docs-api  resource_api.access  operation=document.list  response_status=200
resource-docs-api  resource_api.access  operation=document.get   response_status=200
...
agent-runtime      manifest_hash_stable
```

## 7. 配備した基盤との違い

| 項目 | 配備時 | ローカル |
|---|---|---|
| プロセス | サービスごとに Cloud Run のコンテナ | 1プロセスの中で16の listener |
| Firestore | Firestore | プロセス内の実装。全行を `.local/state/firestore.json` に書き出す（5章） |
| Cloud KMS | KMS の鍵 | `.local/state/kms-master.key` から導出する AES-256-GCM の鍵 |
| Cloud Storage | JWKS と設定のバケット | 8079 番が返す JWK Set と endpoints.json。アプリが書き戻す鍵だけは `.local/state/platform-config` に置く |
| Pub/Sub | 4つの Topic | プロセス内のバス。push は本当に HTTP で配送する |
| Secret Manager | client secret | 起動時に決め打つ固定値。外へ出ない |
| Cloud Scheduler | 5分ごとの tick | `setInterval` |
| 通信路 | HTTPS | ループバックの HTTP |
| Cloud Run の IAM | コンテナの前段で invoker を検査 | 前段は無い。アプリ内の caller 検査はそのまま効く |
| BigQuery | 署名鍵の突合バッチ | 無い。他の検知ルールは同じログを読む |
| 孤児資源の掃除 | プロジェクトを label で走査 | 無い。ここで作った資源はすべてこのプロセスが把握している |

通信路が HTTPS でない点だけは、判断のコードにも影響する。
RFC 8707 は Resource Indicator に絶対 https URI を求め、この基盤もそれを検査している。
ローカルではループバックのリテラル（`127.0.0.1`、`localhost`、`[::1]`）に限って http を認める（`isSecureOrLoopback`）。
ループバックのアドレスは他のホストから観測も到達もできず、DNS で別の場所へ向けることもできないため、https が守っているもの自体が存在しない。
同じ理由で RFC 8252 §7.3 はネイティブアプリのリダイレクトに同じ例外を置いており、この基盤も Human IdP の redirect_uri で既に同じ例外を認めている。
Cloud Run の URL はループバックのリテラルにはならないため、配備時に緩むものは無い。

状態を1つのディレクトリに集めていることも、違いというより性質である。
配備時は Firestore、Cloud KMS、非公開バケットに分かれ、それぞれ別の Service Account しか触れない。
ローカルには境界そのものが無いので、鍵も行も同じディレクトリに並ぶ。
だから `0700` / `0600` で作り、いつ消してもよいものとして扱う。
境界を模した3つのディレクトリを作っても、守るものは1つも増えない。

Execution の開始を 3 秒待つのも、速すぎることを避けるための調整である。
Cloud Run は Job Execution のスケジュールとイメージの取得に数秒かかり、基盤はその数秒に頼っている。
Provisioner が Job を起動して応答を返し、そのあとで Automation App が Agent の最初の指示（何をする Agent なのか）を書くからである。
プロセス内の呼び出しは即座に始まるためこの順序が入れ替わり、Agent は空の会話について一度だけ推論して「終わった」と報告してしまう。
`LOCAL_EXECUTION_START_DELAY_MS` でこの待ちを変えられる。

## 8. 動いていることを検査する

ローカル実行そのものの検査は `apps/local-runner/test/integration/` にある。
`local-platform.spec.ts` は基盤全体を起動し、ブラウザと同じようにログインし、ToDo から権限決定・承認・Provisioning・同意までを歩いて、Agent が登録され Execution が始まるところまでを確認する。
`local-persistence.spec.ts` は基盤を止めてもう一度起動し、ToDo と権限が残っていること、seed が流れ直していないこと、同じ Cookie がまだログインとして通ることを確認する。

```bash
pnpm test:integration
```

失敗したときは `LOCAL_TEST_VERBOSE=true` を付けると、16サービス分の構造化ログが出る。
