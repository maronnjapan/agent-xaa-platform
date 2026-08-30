# 11. アクティビティタイムライン（Activity Monitoring UI）

## 1. 位置づけ

Security Detection（[09](./09-security-monitoring.md)）は、ログから異常を検知しLifecycle Managerへ隔離や失効を依頼する仕組みである。判断の主体は機械であり、人間が関与するのはMEDIUM以上のFindingがHuman Reviewに回ったときだけである（[09. §6](./09-security-monitoring.md#6-response)）。

本書が定義する**アクティビティタイムライン**は、判断そのものを行わない。Policy Engine、Tool Executor、Security Detectionがすでに下した決定を、操作している本人が時系列で追えるように見せるだけの画面である。用途は2つある。

| 用途 | 内容 |
|---|---|
| 通常利用時の可視化 | 自分のログインから、自動化の提案、権限の決定、Agentの実行、外部Resourceへのアクセスまでを一連の流れとして見せる |
| デモ時の可視化 | 権限外の操作や侵害を模した操作を試したとき、それがどこで、なぜ遮断されたかを見せる |

どちらも同じ画面、同じデータで実現する。デモ専用の別画面は作らない。

## 2. 基本方針

- **可視化と判断を分離する**：本画面はAgentやToolの実行を止めたり許可したりしない。表示する遮断は、Tool Executor（[04. §7](./04-tool-catalog.md#7-agentに任意httpを許さない)）、Policy Engine（[03. §6](./03-authorization.md#6-policy-engine)）、Security Detection（[09. §6](./09-security-monitoring.md#6-response)）がすでに下した決定である。
- **自分の範囲だけを見せる**：表示対象はAccess Tokenの`sub`と一致する`human_subject`のイベントに閉じる。他ユーザーのログインやAgentは表示しない。Control Plane APIで`human_subject`を`sub`に固定する既存の考え方（[05. §1.1](./05-identity.md#11-human_subjectの出どころ)）をここでも使う。全ユーザー横断のダッシュボードは今回の対象外とする（[§8](#8-今後の検討事項)）。
- **常に記録する**：Activity Eventの記録は、通常利用かデモかを区別せず、Agentが動くたびに常時行う。デモのために記録を開始する操作は無い。操作者が明示的に行うのは、実演が難しいケースを補うための台本イベントの追加（[§6.2](#62-台本で補う)）だけである。
- **完了してから、まとめて再生する**：実行中のイベントを逐次配信することはしない。常時接続の配信経路は接続維持や順序保証の負担が大きく、途中経過を文字で流すだけでは効果も薄い。ログイン〜Provisioning、Taskごとの処理、Agent終了のそれぞれが完了した時点で、その一連の流れをまとめて再生する（[§3.3](#33-task境界)、[§4](#4-配信経路)）。実行中かどうかだけを素早く知りたい場合は、既存の状況確認（[02. §5](./02-automation-design.md#5-実行中agentの操作)）を使う。
- **一覧だけで終わらせない**：完了した処理は、文字の一覧に加えて、実際に発生した呼び出しの経路をアニメーションで再生する。遮断はその経路がどこで止まったかを動きで示す（[§5](#5-画面)）。
- **人間の操作とAgentの操作を1本の時系列にする**：ログインや追加指示のような人間自身の操作と、Agentの実行結果を別々の画面に分けない。ユーザーから見れば「自分が指示し、Agentが動いた」という1つの流れだからである。
- **表示専用のイベントを別系統で持つ**：Security Detectionが収集する詳細ログ（[09. §2](./09-security-monitoring.md#2-収集するログ)）はDPoP検証結果やID-JAGの`jti`など技術的な内容であり、そのままでは人間向けの説明にならない。本書はこれとは別に、意味のある区切りごとに人間向けの説明文を持つ**Activity Event**を新たに定義する（[§3](#3-activity-event)）。既存の詳細ログを置き換えるものではなく、その横に並ぶ軽量な系統である。
- **遮断のデモは実際の拒否経路を使う**：Tool Executorの拒否やPolicy EngineのDENYは、デモのための特別な演出ではなく実際に動いている仕組みである。安全に再現できるものは実際に操作して見せ、実演が危険または非現実的なものだけ台本化した表示で補う（[§6](#6-侵害を見せるデモ)）。

## 3. Activity Event

### 3.1 スキーマ

Activity Eventは次の形を持つ。

```yaml
activity_event:
  event_id: evt-8f2c1a
  trace_id: trace-9a01
  human_subject: user-123
  agent_id: agent-001         # ログインなどAgent作成前のイベントはnull
  task_id: task-2             # 再生の単位（3.3）。provisioning / task-{n} / lifecycle
  occurred_at: "2026-08-29T10:01:05+09:00"
  source: agent-runtime       # 発行元アプリ
  phase: tool_call            # login / work_definition / authorization / provisioning / tool_call / security / lifecycle
  outcome: blocked            # info / success / blocked
  title: 実行を拒否
  message: mail.message.send は許可されたToolに含まれないため、Tool Executorが実行を拒否しました
  detail:                     # 折りたたみ表示。省略可
    tool_id: mail.message.send
    effective_capabilities: [calendar.event.read]
    reason: not_in_allowed_tools
  related_finding_id: null    # Security DetectionのFindingと対応する場合のみ
  is_simulated: false         # デモ用の台本イベントだけtrue（6.2）
```

`title`と`message`は発行元のアプリがイベントを出す時点で生成する。生データを画面側で人間向けの文章へ変換するロジックは持たせない。理由を最もよく知っているのは、その判断を下した本人（Policy Engine、Tool Executorなど）だからである。

`outcome`は3値に絞る。`denied`と`blocked`のような細分化はしない。ユーザーから見れば「権限が足りず断られた」も「実行中に拒否された」も同じ「止められた」であり、区別する意味が薄いためである。

### 3.2 発行するイベントの例

既存の各段階に対応させる。網羅ではなく代表例を示す。

| phase | event_type | 発生元 | 出典 | 表示例 |
|---|---|---|---|---|
| login | LOGGED_IN | Automation App | [05. §1](./05-identity.md#1-human-identity-provider) | ログインしました |
| work_definition | PROPOSED | Automation App | [02. §1](./02-automation-design.md#1-基本方針) | Automation Design AIが「{purpose}」を提案しました |
| work_definition | CONFIRMED | Automation App | [02. §3](./02-automation-design.md#3-business-work-request) | 作業内容を確定しました |
| authorization | CAPABILITY_DECIDED | Authorization Platform | [03. §6](./03-authorization.md#6-policy-engine) | 許可：{allowed}／却下：{denied}（理由：{reason}） |
| authorization | ISOLATION_DECIDED | Authorization Platform | [03. §7](./03-authorization.md#7-security-profile) | isolation_level={level}に決定（risk_score {n}） |
| provisioning | CONSENT_REQUIRED | Agent Provisioner | [07. §3.2](./07-lifecycle.md#32-provisioning-transaction) | {connector}への追加の同意が必要です |
| provisioning | AGENT_PROVISIONED | Agent Provisioner | [07. §3.3](./07-lifecycle.md#33-end-to-end-provisioning-flow) | Agentを作成しました（有効期限{expires_at}） |
| tool_call | TOOL_SUCCEEDED | Agent Runtime | [04. §6](./04-tool-catalog.md#6-tool-executor) | {tool_id}を実行しました |
| tool_call | TOOL_BLOCKED | Agent Runtime | [04. §7](./04-tool-catalog.md#7-agentに任意httpを許さない) | {tool_id}は許可されたToolに含まれないため拒否しました |
| security | PROTOCOL_VIOLATION | 要求を受けたアプリ（Agent OP、Tool Executor等） | [09. §5.1](./09-security-monitoring.md#51-protocol-validation) | {検証名}に違反したため要求を拒否しました |
| security | AGENT_QUARANTINED | Security Detection | [09. §6](./09-security-monitoring.md#6-response) | 異常検知によりAgentを隔離しました（Finding: {finding_id}） |
| lifecycle | AGENT_STOPPED | Automation App | [02. §5](./02-automation-design.md#5-実行中agentの操作) | Agentを停止しました |
| lifecycle | AGENT_EXPIRED | Lifecycle Manager | [07. §6](./07-lifecycle.md#6-expiration--緊急停止) | 有効期限に達したため終了しました |
| lifecycle | RE_PROVISIONED | Lifecycle Manager | [07. §7.2](./07-lifecycle.md#72-human-userの権限が変更された場合re-provisioning) | 権限変更によりAgentを作り直しました |

CAPABILITY_DECIDEDは`denied`側も表示する。却下されたCapabilityとその理由（Delegatable Permission外、Organization Policy違反など）は、実際には何も実行されていなくても「何が許されなかったか」を示す情報であり、遮断の理解に欠かせない。

### 3.3 Task境界

再生の単位は`task_id`でまとめる。`task_id`は次の3種類のいずれかを持つ。

| task_id | 範囲 | 終端イベント |
|---|---|---|
| `provisioning` | ログインからAgent作成完了まで | AGENT_PROVISIONED |
| `task-{n}` | 最初のWork Definition実行、または追加指示1回ごとの一連の処理 | TASK_COMPLETED（成功）／TASK_BLOCKED（権限外のため一部拒否）／TASK_FAILED（それ以外の失敗） |
| `lifecycle` | Agentの終了 | AGENT_EXPIRED／AGENT_STOPPED／AGENT_QUARANTINED／AGENT_REVOKED_SECURITY |

終端イベントが記録された`task_id`だけが再生の対象になる。終端イベントがまだ無い`task_id`は「実行中」として名前だけ示し、途中経過を先出しで再生しない（[§4](#4-配信経路)）。

TASK_COMPLETED、TASK_BLOCKED、TASK_FAILEDはAgent Runtimeが発行する。1回の指示に対する処理は複数のTool呼び出しを含みうるため、それらがすべて終わった時点でAgent Runtimeが結果を判定する。

## 4. 配信経路

```mermaid
flowchart LR
    H[Automation App<br/>人間の操作] -->|publish| TOPIC[(Pub/Sub<br/>agent-activity-stream)]
    AUTHZ[Authorization Platform] -->|publish| TOPIC
    PROV[Agent Provisioner] -->|publish| TOPIC
    OP[Agent OP] -->|publish| TOPIC
    RUN[Agent Runtime] -->|publish| TOPIC
    LIFE[Lifecycle Manager] -->|publish| TOPIC
    SEC[Security Detection] -->|publish| TOPIC

    TOPIC -->|push subscription| SUB[Automation App<br/>Activity Subscriber]
    SUB -->|write| FS[(Firestore<br/>users/human_subject/activity)]
    BROWSER[ブラウザ<br/>タイムライン画面] -->|task_idごとに要求| SUB
    SUB -->|終端イベントが揃った<br/>Taskだけ返す| BROWSER
```

各アプリはActivity Eventを`agent-activity-stream`というPub/Subトピックへ直接publishする。Security Detectionへの経路（Cloud Logging → Log Sink / Pub/Sub、[09. §4](./09-security-monitoring.md#4-正規化と保存)）とは別系統とし、Cloud Loggingを経由しない。フォレンジック用の詳細ログと、表示用の軽量イベントとで求める速さと形式が異なるためである。

Automation Appはこのトピックをpush subscriptionで受け、`human_subject`ごとにFirestore（`users/{human_subject}/activity/{event_id}`）へ書き込む。この書き込み自体はリアルタイムに行うが、ブラウザへは配信しない。

ブラウザがタイムライン画面を開いたとき、または一覧を更新したときに、Automation Appは`task_id`ごとに終端イベント（[§3.3](#33-task境界)）の有無を確認し、揃っているTaskだけをまとめて返す。終端イベントがまだ無い`task_id`は「実行中」として件数や名前だけを示し、中身は返さない。常時接続の配信経路は持たない。

ブラウザからFirestoreへ直接アクセスすることはしない。取得はAutomation Appの認証済みセッションを介してのみ行う。Firestoreへ直接アクセスさせると、Human IdPが発行するAccess Tokenとは別に、Firestore用の認可の仕組みを新たに持ち込むことになるためである。

`agents/{agent_id}/state`（[02. §5](./02-automation-design.md#5-実行中agentの操作)）とは役割が異なる。`state`は現在の状態のスナップショットであり、停止や追加指示の判断材料として使う。`users/{human_subject}/activity`は完了したTaskの記録であり、終わった後の再生にだけ使う。

## 5. 画面

完了したTask（[§3.3](#33-task境界)）を一覧から選ぶと、そのTaskで実際に何が起きたかを確認できる。

```text
provisioning   Agent agent-001 の作成             成功
task-1         予定を取得して整理する              成功
task-2         抽出した予定を取引先にもメールする    遮断
lifecycle      Agentの終了                        成功
```

文字の一覧だけで終わらせず、そのTaskで実際に呼び出しが発生したアプリを結ぶ図に、呼び出しの動きを加えて再生する。`task-2`の例では、Agent RuntimeからResource APIへ向かう動きが、Tool Executorの位置で止まる。`outcome`が`blocked`のイベントは、こうして宛先に届かない、または押し戻される動きで示し、色や文字の違いだけに頼らない。

再生の配置、配色、間隔といった具体的な意匠は実装時に決める。本書が定めるのは次の3点である。

- 完了した処理は、動きを伴う形で再生し、文字の一覧だけで済ませない。
- 遮断は、動きが止まる・押し戻されるという見た目で伝える。
- `is_simulated: true`のTask（[§6.2](#62-台本で補う)）は、実際に起きたことと常に区別がつく状態で示す。

[§3.1](#31-スキーマ)の`detail`（Capabilityの一覧、Policy ID、Finding IDなど技術的な内容）は、再生とは別に、必要な人だけが確認できるようにする。

## 6. 侵害を見せるデモ

権限外の指示や組織ポリシー違反は、Tool ExecutorやPolicy Engineがその場で判定するため、操作した直後にTaskが完了扱いになる。完了してから再生する設計（[§2](#2-基本方針)）にしても、デモの体感速度はほとんど変わらない。

### 6.1 実操作で見せる

次はAgentやTool Executorに実際に操作させ、既存の拒否経路で遮断させる。

| 見せたい状況 | 実際に踏む経路 | 出典 |
|---|---|---|
| 権限外の操作を拒否される | 追加指示で許可されていない作業を指示する | [02. §5](./02-automation-design.md#5-実行中agentの操作)、[04. §7](./04-tool-catalog.md#7-agentに任意httpを許さない) |
| 組織ポリシーで禁止された操作が通らない | 社外ドメイン宛の送信など、Organization Policyに反する作業を依頼する | [03. §2](./03-authorization.md#2-権限の種類)、[03. §6](./03-authorization.md#6-policy-engine) |
| 有効期限切れ後にアクセスできない | `requested_lifetime_hours`を短く設定したAgentを作り、期限後に追加指示を送る | [07. §4.2](./07-lifecycle.md#42-lifetimeの多層強制)、[07. §6](./07-lifecycle.md#6-expiration--緊急停止) |
| 権限縮小でAgentが作り直される | デモ用にHuman Permissionを縮小するイベントを発行する | [07. §7.2](./07-lifecycle.md#72-human-userの権限が変更された場合re-provisioning) |

いずれも攻撃コードを書く必要がなく、本番の仕組みをそのまま安全に踏める。デモの説得力は、これが演出ではなく実際の拒否であることに支えられている。

### 6.2 台本で補う

次は実演のために本物の攻撃を再現する必要があり、デモ環境であっても実際には行わない。

| 見せたい状況 | 実演が難しい理由 | 出典 |
|---|---|---|
| 委譲関係の偽装（`sub`と`act`の不一致） | 偽の`actor_token`を作る攻撃コードが要る | [09. §5.1](./09-security-monitoring.md#51-protocol-validation)、[05. §6.3](./05-identity.md#63-agent-opの検証手順) |
| ID-JAG署名鍵の目的外使用 | 署名鍵を持ち出す、または悪用する操作そのものになる | [09. §5.1](./09-security-monitoring.md#51-protocol-validation)、[05. §3.3](./05-identity.md#33-agent-op署名鍵の制約) |
| Cross-Agent Isolationの侵害 | 他Agentの設定へ実際に到達する経路を作る必要がある | [09. §5.2](./09-security-monitoring.md#52-rule-based-detection) |
| DPoP Proofの再送 | 正規のProofを盗聴し再利用する操作になる | [05. §2.1](./05-identity.md#21-受け取り側の検証手順) |

これらは、あらかじめ用意した`is_simulated: true`のActivity Eventを、実際のAgentやSecurity Detectionを経由せずタイムラインへ直接書き込むデモ専用の操作で補う。トリガーは操作者自身のセッションでのみ有効な機能とし、他ユーザーのタイムラインへは書き込めない（[§7](#7-アクセス制御)）。

## 7. アクセス制御

- タイムラインの参照範囲はAccess Tokenの`sub`と一致する`human_subject`に限る（[05. §1.1](./05-identity.md#11-human_subjectの出どころ)と同じ考え方）。
- ブラウザはFirestoreへ直接アクセスしない。取得はAutomation Appの認証済みセッションを介してのみ行う（[§4](#4-配信経路)）。
- [§6.2](#62-台本で補う)の台本再生も操作者自身のセッション範囲に閉じる。他ユーザーのタイムラインへ`is_simulated`イベントを注入することはできない。

## 8. 今後の検討事項

次は今回の対象外とし、必要になった時点で改めて設計する。

- **全ユーザー横断のデモ観覧画面**：会場のスクリーンに複数ユーザー・複数Agentの動きを同時に映したいという要望が出た場合、閲覧用の権限モデルを新たに作る必要がある。現時点ではAutomation Appへログインした本人だけが自分のタイムラインを見る。
- **`users/{human_subject}/activity`の保持期間**：Agent破棄後どれだけ残すかは未決定である。
