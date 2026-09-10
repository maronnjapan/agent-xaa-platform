# 04. Tool / Connector CatalogとTool Executor

## 1. Tool / Connector Catalogとは

Tool / Connector Catalogは、**抽象Capabilityを具体的な実行手段へ翻訳する辞書**である。
Authorization Platformが決めるのは `calendar.event.read` までであり、「それをどのAPIで、どの認証方式で実行するか」はこのCatalogが持つ。

| 保持する情報 | 例 |
|---|---|
| Capability → Tool の対応 | `calendar.event.read` → `stub.calendar.events.list` |
| Tool の認証方式 | `native_xaa` / `xaa_bridge` |
| XAA の audience / resource / scope | `google-bridge` / `google-calendar` / `calendar.read` |
| Token取得先 | Google Bridge、社内Resource AS |
| API Endpoint、HTTP Method、Request Schema | `GET /calendar/v3/calendars/{calendarId}/events` |
| Resource Type、Risk Level | `oauth_bridge`, `low` |

位置づけ：

- アプリではなく定義データである。Firestoreの `catalog_tools` と `catalog_connectors` に保持し、プラットフォーム管理者が管理する（§5.1の画面）。AIは編集しない。
- 読むのはAgent Provisioner（Provisioning時にAgentが使えるToolとXAA設定を確定する）と、Tool Executor（Provisionerから渡されたTool Manifestに従って実行する）である。
- Agent OPやAuthorization Platformはこの情報を持たない。

## 2. Resourceの2種類

Catalog上の各Connectorは `resource_type` でどちらかに分類する。

| resource_type | 意味 | 例 | フロー |
|---|---|---|---|
| `native_xaa` | Resource Authorization Server自身がID-JAGを理解する | 社内API、XAA対応SaaS | Agent → Agent OP → ID-JAG → Resource AS → Access Token → Resource API |
| `oauth_bridge` | 外部SaaSがID-JAGを理解しないため、Bridgeが外部OAuth Credentialと交換する | Google、Microsoft、GitHub | Agent → Agent OP → ID-JAG → Bridge → 外部OAuth AS → 外部Access Token → Agent → SaaS API |

Native XAA ResourceにBridgeを強制しない。
Bridgeは互換レイヤーとしてのみ使う（[06. OAuth Bridge](./06-oauth-bridge.md)）。

### 2.1 ドキュメントの管理画面

Native Resourceの中身を人が直す画面を、そのResource自身が持つ。
Document Resource API（`resource-docs-api`）の画面がそれである。
Automation Appにも Authorization Platform にも置かないのは、データを持つアプリがそのデータを直すアプリだからである。

| 画面 | パス | 何をするか |
|---|---|---|
| ドキュメント一覧 | `GET /admin/documents?owner_subject={human_subject}` | 1人を指定し、その人のドキュメントを新しい順に最大100件並べる。`type` で絞り込める |
| ドキュメントの作成 | `GET /admin/documents/new` と `POST /admin/documents` | `owner_subject`、`type`、タイトル、本文、`occurred_at` を決める |
| ドキュメントの編集 | `GET /admin/documents/{document_id}` と `POST /admin/documents/{document_id}` | タイトルと本文を直す。`version` を持って送り、ずれていれば拒否する |
| ドキュメントの削除 | `GET /admin/documents/{document_id}/delete` と `POST /admin/documents/{document_id}/delete` | 何を消すかを見せてから消す |

画面が読み書きするのは、XAAで守られた `/documents` が返すのと同じ行である。
別のストアも別の形も持たない。
違うのは、誰が求めているかと、何ができるかである。

- `/documents`：委譲されたDPoP束縛のXAA Access Tokenを持つAgentが相手であり、`docs.read` と `docs.write` で読み書きする。DELETEは無い。
- `/admin/documents`：`ADMIN_PRINCIPALS` に挙げたGoogleアカウントのID Tokenが相手であり、削除もできる。

削除がAgent側に無いのは、書き込みを委譲したことが「記録を無かったことにしてよい」という委譲ではないからである。

編集で変えられるのはタイトルと本文だけである。
`type` と `occurred_at` は書いたときのままにする。
APIの `PATCH /documents/{document_id}` がその2つを受け取らないので、画面だけが変えられると、画面とAPIが同じ行について違うことを言うことになる。
`type` は自由入力ではなく `DOCUMENT_TYPES` からの選択にする。
保存の直前にドキュメントの形を検査しており、そこに無い `type` は「書いて拒否される行」ではなく、誰も打ち込んでいない検査失敗になるためである。

保存は `version` を持って送る。
同じドキュメントを2人が開いていたとき、あとから押した保存が黙って勝つことがない。
ずれていれば拒否し、いま保存されている内容を見せる。

seedのJobは `documents` を空にしない。
`infra/seed/documents-demo.yaml` の行はその内容から決まるIDを持つので、seedをもう一度流すと同じ行が書き直される。
画面で作ったドキュメントはそのまま残り、画面で消したデモ用ドキュメントは戻ってくる。

画面へ到達できるのは、`ADMIN_PRINCIPALS` に挙げたGoogleアカウントだけである。
Document Resource APIはInternetへ公開しない（RULE-37）ため、管理者は `gcloud run services proxy` 経由で開く。
`ADMIN_PRINCIPALS` が空のときに到達できるのは誰でもなく、全員ではない。

画面はサーバ側でReactを描画したHTMLだけを返し、ブラウザへスクリプトを送らない。
理由は権限の管理画面と同じである（[03. §2.1](./03-authorization.md#21-権限の管理画面)）。

## 3. Connector Definition例

```yaml
# Native XAA
connector_id: internal-docs-api
resource_type: native_xaa
authorization:
  audience: https://auth.customer.example.com
  resource: https://api.customer.example.com
tools:
  - internal.document.list
  - internal.document.get
```

```yaml
# OAuth Bridge
connector_id: google-workspace
resource_type: oauth_bridge
bridge:
  audience: https://google-bridge.example.com
tools:
  - stub.calendar.events.list
  - google.gmail.message.read
  - google.gmail.message.send
```

## 4. Tool Definition例

```yaml
# OAuth Bridge経由（Google Calendar）
tool_id: stub.calendar.events.list
description: Google Calendarから予定を取得する
required_capability: calendar.event.read
authorization:
  type: xaa_bridge
  audience: google-bridge
  resource: google-calendar
  scope: calendar.read
token:
  provider: google-bridge
api:
  base_url: https://www.googleapis.com
  method: GET
  path: /calendar/v3/calendars/{calendarId}/events
parameters:
  calendarId: { required: true }
  timeMin:    { required: false }
  timeMax:    { required: false }
risk_level: low
```

```yaml
# Native XAA（社内顧客API）
tool_id: internal.document.list
description: 顧客情報一覧を取得する
required_capability: customer.read
authorization:
  type: native_xaa
  audience: https://auth.customer.example.com
  resource: https://api.customer.example.com
  scope: customer.read
api:
  base_url: https://api.customer.example.com
  method: GET
  path: /customers
risk_level: medium
```

## 5. Provisioning時のTool解決

Agent Provisionerは、Effective CapabilityからCatalogを引いて、そのAgentが使える**Allowed Tools**と**XAA静的設定**を確定する。

```text
Effective Capability          Allowed Tools
  calendar.event.read    →      stub.calendar.events.list
                                google.calendar.events.get
  mail.message.send      →      google.gmail.message.send
```

確定した結果は次の2箇所へ静的に注入する。

- Agent OP：許可するaudience / resource / scope（[05. §3](./05-identity.md#3-agent-op)）
- Agent Runtime：Tool Manifest（Allowed ToolsとそのAPI定義）

Agent生成後にRegistryへ問い合わせて動的にToolやaudienceを決めることはしない。

### 5.1 権限とリソースのマッピング画面

CapabilityとToolの対応は、Agent Provisionerの画面から変える。
この画面がAuthorization Platformではなく、ましてAutomation Appでもなくここにあるのは、Catalogを持つのがProvisionerだからである（RULE-16、RULE-07）。

| 画面 | パス | 何をするか |
|---|---|---|
| マッピング一覧 | `GET /admin/mappings` | Connector（Resource）ごとにToolを並べ、それぞれが必要とするCapabilityを表示する。Capabilityから見た対応表と、対応するToolが1つも無いCapabilityの警告も出す |
| マッピングの保存 | `POST /admin/mappings` | 送られたToolの `required_capability` を書き換える |

変えられるのは `required_capability` だけである。
URL、HTTP Method、scope、audienceは画面からもどこからも実行時に変えられない。
任意のURLをToolに与えられる画面は、RULE-17が防いでいる「Agentに任意HTTPを許す」ことと同じになるためである。

送信されたToolまたはCapabilityが存在しない場合、1件も書かずに全体を拒否する。
Capabilityの存在はCapability Taxonomyで確かめる。
Taxonomyに無いCapabilityへ向いたToolは、Policy Engineがそれを落とすため、どの決定からも到達できないResourceになるからである。

変更が効くのは、これ以降にProvisioningされるAgentである。
実行中のAgentはProvisioning時に確定したTool Manifestで動き続ける（RULE-19）。

seedのJobは `catalog_tools` を一度空にしてからYAMLを書き直すため、画面での変更を残すなら `infra/seed/tools/` の該当ファイルにも同じ `required_capability` を入れる。

到達できるのは `ADMIN_PRINCIPALS` に挙げたGoogleアカウントだけであり、Agent ProvisionerはInternetへ公開しないため（RULE-37）、管理者は `gcloud run services proxy` 経由で開く。

## 6. Tool Executor

Tool Executorは**Agent Runtime内部のモジュール**であり、独立したアプリではない。
AI（LLM）が「どのToolを使うか」を決め、Tool Executorが「どう実行するか」を決定論的に処理する。

| 担当 | 決めること |
|---|---|
| Agent Reasoning（LLM） | WHAT：どのToolを、どのパラメータで使うか |
| Tool Executor | HOW：どのOPへ行くか、どのID-JAGを取るか、どのAuthorization Serverへ渡すか、Access Tokenをどう取得するか、どのAPI Endpointを叩くか |

Tool Executorの処理：

```text
1. Tool Manifest読み込み
2. Toolが Allowed Tools に含まれるか確認（含まれなければ拒否）
3. Agent Expiration確認
4. Agent OPへToken Exchange（audience / resource / scope はManifestの値。subject_token / actor_token / DPoP Proofを添える）
5. Resource AS または Bridge へID-JAGを提示し、Access Token取得
6. API Request生成と実行
7. Responseを構造化してAgent Reasoningへ返却

4と5の中身は [05. §6](./05-identity.md#6-cross-app-access) にある。
```

4と5は、この Execution が同じ audience と resource と scope のAccess Tokenを有効期限内で持っている場合には行わない。
持っているものをそのまま提示し、Agent OPとResource ASへは何も送らない。
呼び出しのたびに取り直しても、同じ委譲を同じ2つのサービスへ問い直して同じ答えを受け取るだけであり、増えるのはKMS署名とネットワーク往復である。
Tokenはメモリにしか置かず、Job Executionの終了とともに消える（[05. §9](./05-identity.md#9-tokenの種類と保持ルール)）。

2と3は、Tokenを持っているかどうかに関わらず毎回行う。
Access Tokenを持っていることは権限ではない。
Agentを止める経路も変わらない。
Cleanupのstep1がJob Executionを取り消してプロセスごとTokenを消し、step5が各Resource ASへ `act` 単位のRevokeを送る（[07. §6](./07-lifecycle.md#6-expiration--緊急停止)）。

```mermaid
flowchart LR
    INTENT["Agent Intent<br/>今日の予定を確認"] --> TOOL["Tool Selection<br/>stub.calendar.events.list"]
    TOOL --> CAP["Required Capability<br/>calendar.event.read"]
    CAP --> AUTH["Auth Mapping<br/>（Tool Manifest）"]
    AUTH --> OP["Agent OP"]
    OP --> JAG["ID-JAG"]
    JAG --> AS["Resource AS / Bridge"]
    AS --> TOKEN["Access Token"]
    TOKEN --> API["Resource API"]
```

## 7. Agentに任意HTTPを許さない

Agentが好きなURL、Method、scope、audienceを自由に生成してアクセスする設計にはしない。
AgentはProvisioning済みのToolを選択するだけである。

```text
AI Reasoning  →  Tool Selection  →  Deterministic Tool Executor
```

これにより、プロンプトインジェクションなどでAgentが想定外の操作を試みても、Allowed Toolsに含まれない操作はTool Executorの段階で拒否される。
