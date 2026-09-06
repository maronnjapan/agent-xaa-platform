# Google Bridge を試す

Google Bridge は、この platform の ID-JAG を理解しない外部 SaaS の前に立つ Resource Authorization Server である。
設計は[06. OAuth Bridge](./06-oauth-bridge.md)にあり、ここに置くのは配備して実際に通すまでの手順である。

Bridge は既定で配備されない（`enable_google_bridge = false`）。
有効にすると Cloud Run Service が2つ（内部面の `google-bridge` と公開する callback 面の `google-bridge-callback`）増える。

## 1. どちらのモードで試すか

接続先の SaaS は `SAAS_CONNECTOR_MODE` で選ぶ。
2つは「何を確かめられるか」が違うので、目的から選ぶ。

| | `stub`（既定） | `google` |
|---|---|---|
| 接続先 | 同じプロジェクトへ配備する stub SaaS | 本物の Google |
| 用意するもの | 無し | Google OAuth client（本書の§3） |
| 同意画面 | stub のログイン画面 | Google のアカウント選択と同意 |
| 確かめられること | 同意から Tool 呼び出しまでの全部 | OAuth client、同意画面、Connection の保持まで |
| Tool 呼び出し | 通る | 通らない（§4） |

Bridge の仕組みそのもの（ID-JAG の検証、Connection と Agent Binding の2層、Refresh Token の保持、Access Token の払い出し）を端から端まで見るなら `stub` を使う。
用意するものが無く、Google アカウントも要らない。

`google` は、作った OAuth client と同意画面と redirect URI が正しいかを、本物の Google 相手に確かめるためのモードである。

## 2. stub モードで通す

```bash
PROJECT_ID=<project-id> ENABLE_GOOGLE_BRIDGE=true scripts/deploy-gcp-guide.sh all
```

デプロイ後、画面の操作は[サイトの使い方](./user-guide.md)と同じである。
違うのは2点だけである。

Human Permission に `calendar.event.read` が要る。
`scripts/deploy-gcp-guide.sh` は `ENABLE_GOOGLE_BRIDGE=true` のときこれを付ける（[infra/README.md](../infra/README.md)）。
`GRANT_DEMO_PERMISSIONS=0` で配備した場合は自分で付ける。

```bash
GOOGLE_CLOUD_PROJECT=<project-id> STORE_MODE=gcp PUBSUB_MODE=gcp \
  pnpm perm:set testuser calendar.event.read grant
```

そのうえで、予定を読む作業を書く。
「今週の予定を読んで、日報の下書きに書き足す」のように、カレンダーを読むことが作業内容から読み取れる文にする。
Authorization Platform が `calendar.event.read` を Effective Capability に含めると、Provisioner はそれを bridged な Tool へ解決し、SaaS への同意を求めて一度止まる。

画面には「外部サービスの接続の同意が必要です」が出て、接続先と同意を求める範囲が並ぶ。
そこから stub の同意画面へ飛び、承認して戻ると、Agent の作成が続きから再開する。

同じ人の2人目の Agent では、この同意画面は出ない。
Connection は Agent ではなく人に属し、Agent が持つのはそこから切り出した Agent Binding だからである（[06. §3](./06-oauth-bridge.md#3-credential保持方針)）。

## 3. google モードで使う OAuth client を用意する

Google 側で作るのは、ウェブアプリケーション種別の OAuth client 1つである。
Google Cloud Console の4ページを上から順に設定する。
`scripts/deploy-gcp-guide.sh` は、必要な設定が足りないとこの4つの URL と、貼り付ける redirect URI を表示して終わる。

### 3.1 ブランディング

`https://console.cloud.google.com/auth/branding?project=<project-id>`

アプリ名、ユーザーサポートメール、デベロッパーの連絡先情報を入れて保存する。
ここを保存するまで、以降の3ページは開いても設定できない。

### 3.2 対象

`https://console.cloud.google.com/auth/audience?project=<project-id>`

ユーザーの種類に「外部」を選ぶ。
公開していないアプリで同意できるのはテストユーザーだけなので、自分の Google アカウントをテストユーザーへ追加する。

追加を忘れると、同意画面まで到達したうえで `access_denied` になる。
Bridge のログには `code_exchange_failed` ではなく、callback へ戻ってこなかったことだけが残る。

### 3.3 データアクセス

`https://console.cloud.google.com/auth/scopes?project=<project-id>`

接続先 API のスコープを追加する。
カレンダーを読むなら `https://www.googleapis.com/auth/calendar.readonly` である。

このスコープ文字列は、seed が `connector_definitions` へ書く `scope_map` の値と一致していなければならない（`apps/seed/src/connector-definitions.ts`）。
Google はこの platform の `calendar.read` という名前を知らないため、Bridge が SaaS との境界だけで名前を翻訳している。

### 3.4 クライアント

`https://console.cloud.google.com/auth/clients/create?project=<project-id>`

アプリケーションの種類に「ウェブ アプリケーション」を選ぶ。
「承認済みのリダイレクト URI」へ次の値を貼り付ける。

```
https://google-bridge-callback-<project-number>.<region>.run.app/stub-saas-calendar/oauth/callback
```

`<project-number>` はプロジェクト番号（プロジェクト ID ではない）、`<region>` は配備するリージョンである。
Cloud Run の既定ホスト名はこの2つから決まるため、apply の前でも確定できる。
プロジェクト番号は `gcloud projects describe <project-id> --format='value(projectNumber)'` で調べる。

URI の途中に入る `stub-saas-calendar` は、Bridge が `connector_definitions` を引く connector id である。
catalog が名指す bridged connector は1件だけで、両モードともその id で定義を書く。
別の名前を入れると、Google から戻った callback が `invalid_target` で止まる。
同意そのものは済んでいるので、画面には「認可を完了できませんでした」だけが出る。

作成すると client ID と client secret が表示される。
secret はこの1回しか表示されないので、その場でファイルへ保存する。

## 4. google モードで配備する

```bash
PROJECT_ID=<project-id> \
ENABLE_GOOGLE_BRIDGE=true \
SAAS_CONNECTOR_MODE=google \
GOOGLE_OAUTH_CLIENT_ID=<client-id>.apps.googleusercontent.com \
GOOGLE_OAUTH_CLIENT_SECRET_FILE=/secure/path/client-secret.txt \
scripts/deploy-gcp-guide.sh all
```

client secret はスクリプトの標準出力に出ない。
Secret Manager の `google-oauth-client-secret` へ version として入り、Bridge は呼び出しのたびにそこから読む。
すでに有効な version があるときは再利用する。差し替えるなら `ROTATE_GOOGLE_OAUTH_SECRET=1` を付ける。

値を直接渡す `GOOGLE_OAUTH_CLIENT_SECRET` もあるが、シェルの履歴に残るため、ファイル経由を選ぶ。

画面の操作は§2と同じで、同意画面が Google のものになる。
承認して戻ると Connection ができ、Agent Binding が作られ、Agent が動き出す。

### Tool 呼び出しがどこで止まるか

Agent が実際にカレンダーを読もうとすると、Google は 404 を返す。
catalog にある calendar の Tool は stub SaaS の URL の形（`/calendar/events`）で書かれており、Google の API はその位置に無いためである。
Tool ID の全集合は[実装規約](../tasks/00b-conventions.md)が8件に固定しているので、Google 用の Tool を1件足すという回避もしていない。

つまり `google` モードで確かめられるのは、OAuth client と同意画面と redirect URI が正しいこと、そして Connection と Agent Binding が正しく作られることまでである。
Tool 呼び出しまで含めて通したいときは `stub` モードを使う。

## 5. 通ったかどうかを確かめる

画面のタイムライン（`/activity`）に、その Agent の物語として次の2つが並ぶ。

- 「外部サービスの接続の同意が必要です」：接続先と、同意を求める範囲が書いてある
- 「外部サービスと接続しました」：使える範囲と有効期限が書いてある

Firestore には次の行ができている。

| コレクション | 何が入るか |
|---|---|
| `connector_definitions` | seed が書いた接続先の定義1件。client secret は入らず、Secret Manager の名前だけが入る |
| `bridge_connections` | 人ごとの Connection。Refresh Token は KMS で暗号化された状態でだけ入る |
| `agent_bindings` | Agent ごとの Binding。Connection から切り出した範囲と、Agent の有効期限が入る |

同意が返ってこないまま30分が過ぎた Provisioning Transaction は、Lifecycle の sweep が `ABANDONED` にする。
その場合は作業内容の確定からやり直す。

## 6. うまくいかないとき

| 症状 | 原因 | 直し方 |
|---|---|---|
| 同意画面へ進まず「接続先が見つかりません」 | seed Job が走っていない、または `connector_definitions` が空 | `make seed PROJECT_ID=<id>` |
| Google の同意画面が `invalid_scope` | データアクセスへ追加したスコープと `scope_map` の値が違う | §3.3 のスコープを見直す |
| Google の同意画面が `redirect_uri_mismatch` | OAuth client の redirect URI が違う | §3.4 の URI を貼り直す。project number とリージョンと connector id の3つを確かめる |
| 承認して戻ると「認可を完了できませんでした」 | redirect URI の connector id が `connector_definitions` の id と違う | 同上 |
| 同意画面まで進んで `access_denied` | テストユーザーに自分のアカウントが入っていない | §3.2 で追加する |
| Agent は作られるが SaaS 呼び出しが `invalid_bridge_binding` | Agent Binding が無い | Provisioning のタイムラインに「外部サービスと接続しました」があるかを見る |
| 権限を調べても calendar が出ない | `calendar.event.read` の Human Permission が無い | §2 の `perm:set` |

## 7. 片付ける

Bridge の callback 面はインターネットへ公開されている。
検証が終わったら他のアプリと一緒に破棄する。

```bash
PROJECT_ID=<project-id> make demo-destroy
```

Google 側に残るのは OAuth client と同意画面の設定である。
プロジェクトごと消さないなら、`https://console.cloud.google.com/auth/clients?project=<project-id>` から client を削除する。
