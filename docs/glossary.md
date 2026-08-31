# 用語辞書

同じ概念に別名が生まれるのを防ぐための表である。
語の定義は docs 01 にあり、ここでは1文で要約したうえで実装側の識別子を並べる。

`実装識別子` 列は、TypeScript の型名、Firestore のコレクション名、API のフィールド名のうち
該当するものを ` / ` で区切って書く。推測した名前は書かない。

## 1. 用語と実装識別子

| 用語 | 定義（1文） | 実装識別子 | 定義元 |
|---|---|---|---|
| Human Identity | 人間そのものの身元で、Human IdP が発行する ID Token の `sub` で表す | `human_subject` | 01. §3.2 |
| Agent Identity | 人間の代理として動く Agent 固有の身元で、ID-JAG の `act.sub` で表す | `AGENT_URN_PREFIX` / `toAgentUrn` / `agent_id` | 01. §3.2 |
| Human Permission | その人間自身が持っている権限 | `human_permissions` | 01. §3.3 |
| Delegatable Permission | 人間の権限のうち Agent へ委譲してよい範囲 | `delegatable_permissions` | 01. §3.3 |
| Organization Policy | 組織として一律に禁止または許可する範囲 | `organization_policies` | 01. §3.3 |
| Risk Policy | リスクに応じて Isolation Level と制約を決める規則 | `risk_policies` | 01. §3.3 |
| Authorization AI Proposed Capability | Authorization AI が Work Definition から推論した Capability の候補 | `ai_proposals` / `proposed_capabilities` | 01. §3.3 |
| Effective Agent Permission | 5つの集合の積として決まる、Agent が実際に持つ権限 | `effective_capabilities` / `computeEffectiveCapabilities` | 01. §3.3 |
| Work Definition | 自動化したい作業を業務の言葉で書いたもの | `WorkDefinition` / `work_definitions` | 01. §3.4 |
| Capability | 権限の抽象単位で、`<resource>.<object>.<action>` の形を取る | `Capability` / `CAPABILITIES` | 01. §3.4 |
| Capability Taxonomy | 使用できる Capability の全集合 | `capability_taxonomy` | 01. §3.4 |
| Tool | Agent が呼べる具体的な API 操作 | `CatalogTool` / `catalog_tools` / `tool_id` | 01. §3.4 |
| Connector | 1つの Resource への接続方法をまとめた定義 | `CatalogConnector` / `catalog_connectors` / `connector_definitions` | 01. §3.4 |
| Tool / Connector Catalog | Tool と Connector の一覧 | `catalog_tools` / `catalog_connectors` | 01. §3.4 |
| Cross App Access | ID-JAG を介してアプリ間の委譲を運ぶ方式 | `ID_JAG_TOKEN_TYPE` / `TOKEN_EXCHANGE_GRANT_TYPE` | 01. §3.4 |
| ID-JAG | 委譲の事実を表す短命の Grant | `ID_JAG_TOKEN_TYPE` / `JWT_TYP.ID_JAG` | 01. §3.4 |
| Agent OP | Agent へ ID-JAG を発行する OpenID Provider | `agent-op` / `AGENT_OP_BASE_URL` | 01. §3.4 |
| subject_token | 委譲元の人間を表す ID Token | `TOKEN_TYPE_ID_TOKEN` / `subject_token` | 01. §3.4 |
| actor_token | Agent が自分自身を主張する assertion | `ACTOR_TOKEN_TYP` / `actor_token` | 01. §3.4 |
| Human IdP Connection | Agent ごとに払い出した Human IdP への接続 | `idp_connections` / `idp_connection_id` | 01. §3.4 |
| Agent Registration | Agent OP が Agent について知ってよい登録情報 | `ProvisionedRegistration` / `agents/{agent_id}/meta` | 01. §3.4 |
| OAuth Bridge | ID-JAG を理解しない外部 SaaS へつなぐ互換レイヤー | `google-bridge` / `bridge_connections` / `agent_bindings` | 01. §3.4 |
| Native XAA Resource | ID-JAG を直接受け取れる Resource Server | `resource-docs-as` / `resource-finance-as` | 01. §3.4 |
| Security Profile | Risk Score と Isolation Level と理由をまとめた判定結果 | `SecurityProfile` / `security_profile` | 01. §3.4 |
| Isolation Level | Agent の分離の強さで、`standard` と `full_isolation` の2値 | `IsolationLevel` / `isolation_level` | 01. §3.4 |
| Agent Identity Domain | 1つの Agent に属する Identity と鍵と接続と実行の参照をまとめた単位 | `AgentIdentityDomain` / `agents/{agent_id}/meta` | 01. §3.4 |

## 2. 確定した命名

### Capability（8件）

| Capability | 対象 |
|---|---|
| `calendar.event.read` | カレンダーの予定を読む |
| `calendar.event.write` | カレンダーの予定を書く |
| `mail.message.read` | メールを読む |
| `mail.message.send` | メールを送る |
| `document.read` | 書類を読む |
| `document.write` | 書類を書く |
| `finance.payment.read` | 支払を読む |
| `finance.payment.approve` | 支払を承認する |

### Resource AS の scope（7件）

| scope | 対象 |
|---|---|
| `docs.read` | Document Resource の読み取り |
| `docs.write` | Document Resource の書き込み |
| `finance.tx.read` | Finance Resource の読み取り |
| `finance.tx.write` | Finance Resource の書き込み |
| `calendar.read` | 外部カレンダーの読み取り |
| `gmail.read` | 外部メールの読み取り |
| `gmail.send` | 外部メールの送信 |

### Tool ID（7件）

| Tool ID | 対象 |
|---|---|
| `internal.document.list` | 書類の一覧 |
| `internal.document.get` | 書類の取得 |
| `internal.document.create` | 書類の作成 |
| `internal.document.update` | 書類の更新 |
| `internal.finance.payment.list` | 支払の一覧 |
| `internal.finance.payment.get` | 支払の取得 |
| `internal.finance.payment.approve` | 支払の承認 |

`stub.calendar.events.list` は Bridge 経路の検証用で、`enable_google_bridge=true` のときだけ現れる。

## 3. 使わない別名

次の名前は検討の過程で出たが採用しなかった。コードにも文書にも書かない。
一覧は `glossary.forbidden.txt` にあり、`docs:glossary` がリポジトリ全体を検査する。

`document.content.read` / `document.content.write` / `documents.read` / `docs.document.read` /
`docs.document.write` / `transactions.read` / `transfers.write` / `finance.transaction.read` /
`internal.customer.` / `google.calendar.events.list`
