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
- **一覧だけで終わらせない**：完了した処理は、文字の一覧に加えて、実際に発生した呼び出しの経路をアニメーションで再生する。遮断はその経路がどこで止まったかを動きで示す（[§5.2](#52-再生の中身)）。
- **一文で終わらせない**：`title` と `message` は「何が起きたか」を一文で言う。だが人が実際に知りたいのは「どこへ何を送り、何が返り、送る前に何を確かめ、Agent 自身は何と書いたか」であり、これは一文でも key/value の平坦な表でも表せない。そこで発行元が、順序を持った内訳（**Activity Record**、[§3.4](#34-activity-record)）を書く。画面はそれを並べるだけで、文章は作らない。
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
    target: resource-api      # 再生でどの箱へ向かう動きかを示す。省略可
  record:                     # この1件の内訳（3.4）。省略可
    headline: mail.message.send の実行を拒否しました
    checks: [...]
    sections: [...]
    hops: [...]
  related_finding_id: null    # Security DetectionのFindingと対応する場合のみ
  is_simulated: false         # デモ用の台本イベントだけtrue（6.2）
```

`title`と`message`は発行元のアプリがイベントを出す時点で生成する。生データを画面側で人間向けの文章へ変換するロジックは持たせない。理由を最もよく知っているのは、その判断を下した本人（Policy Engine、Tool Executorなど）だからである。

`outcome`は3値に絞る。`denied`と`blocked`のような細分化はしない。ユーザーから見れば「権限が足りず断られた」も「実行中に拒否された」も同じ「止められた」であり、区別する意味が薄いためである。ただし`phase`が`tool_call`か`security`かで、画面上の強調度を変える（[§5.3](#53-表示のルール)）。

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
| authorization | PERMISSION_CHANGE_IGNORED | Authorization Platform | [07. §7.2](./07-lifecycle.md#72-human-userの権限が変更された場合re-provisioning) | 権限が広がりましたが、実行中のAgentには反映しません |

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

### 3.4 Activity Record

`title` と `message` は一文、`detail` は平坦な key/value である。どちらも「Agentがどこへ何を送り、何が返り、送る前に何を確かめ、自分では何と書いたか」には答えられない。答えは順序を持つからである。

そこで**Activity Record**を置く。1件のActivity Eventの内訳であり、次の4つを持つ。

| 要素 | 内容 |
|---|---|
| `headline` | その1手を一言で言うと何だったか |
| `checks` | 実行の前に確かめたことと、その結果（`passed` / `blocked` / `failed` / `skipped`） |
| `sections` | 見出しつきの区画。`label`、一文の`message`、名前つきの値（`fields`）、本文（`text`）を持つ |
| `hops` | その処理で実際に発生した、箱から箱への移動（[§5.2](#52-再生の中身)） |

**人が読む文字列は、すべて発行元がその場で書く。** `label`も`message`も`text`も、判断を下した本人が、判断した時点の言葉で埋める。画面はそれらを並べ、字下げし、どこを畳むかを決めるだけで、一文も作らない（RULE-54）。`status: 403`を画面が「拒否されました」と言い換えれば、それは自分が立ち会っていない出来事を画面が解釈したことになり、文言を変えた日に過去の記録まで書き換わる。

`checks`の`skipped`は埋め草ではない。許可されていないToolとして最初の段階で断られた呼び出しは、そもそも制約の確認まで到達していない。「制約を満たした」と「制約を見ていない」は別のことである。

Tool呼び出しでAgent Runtimeが記録する内容を挙げる。

| 区画 | 内容 |
|---|---|
| `intent` | 選んだTool、渡そうとした引数、そしてAgent自身がその手で書いた文章 |
| `capability` | そのToolが要求するCapability |
| `authorization` | Catalogが決めている宛先（`audience`）、対象（`resource`）、範囲（`scope`） |
| `access_token` | 受け取ったAccess Tokenの有効期限と提示方法。Tokenそのものは記録しない |
| `request` | Method、宛先、送った本文、宣言に無いため落とした引数 |
| `response` | HTTPステータス、所要時間、許可された項目だけに絞った後の値 |
| `failure` | 止まった段階と種別。止まった場合だけ |

Recordは人に見せるものであり、タイムラインが残る限り残る。Raw Token、Secret、Private Keyを入れてはならない（RULE-38）。発行元が入れないだけでなく、応答本文に紛れ込んだ場合に備えて、書き出す直前にJWT形状の文字列を落とし、長すぎる本文を切り詰める。

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

### 5.1 画面の構成

タイムライン画面は3段になる。

1. **一覧**：ユーザーの全Agentについて、完了した`task_id`を新しい順に並べる。各行はAgentの目的、区分（`provisioning` / `task-{n}` / `lifecycle`）、終端の`outcome`、完了時刻を示す。実行中の`task_id`は「実行中」の行として名前だけ出し、選べない。
2. **再生**：そのTaskに含まれるActivity Eventをアニメーションで再生する（[§5.2](#52-再生の中身)）。
3. **起きたことの一覧**：同じイベントを、サーバー側で描画した文章として上から並べる（[§5.4](#54-起きたことの一覧)）。

2と3は代替ではない。再生は「何と何が話し、どこで止まったか」に答え、文章は「何を送り、何が返り、先に何を確かめたか」に答える。片方だけでは、もう片方の問いが残る。アニメーションを見られない人にとっても、失われるのは動きだけである。

Google Calendarの予定を整理するAgent（[02. §1](./02-automation-design.md#1-基本方針)の例）で、追加指示によって権限外の送信を試みた場合の一覧を示す。

```text
provisioning   Agent agent-001 の作成                          成功   10:00:50
task-1         予定を取得して整理する                           成功   10:01:07
task-2         抽出した予定を取引先にもメールする                 遮断   10:03:01
lifecycle      Agentの終了                                     成功   10:05:00
```

`task-2`は、ユーザーが自分から権限外の指示を試した結果であり、実際にTool Executorが下した拒否である（[§6.1](#61-実操作で見せる)）。これを選ぶと[§5.2](#52-再生の中身)の再生が始まる。

### 5.2 再生の中身

再生は、そのTaskで実際に呼び出しが発生したアプリを結ぶ図に、呼び出しの動きを重ねたものである。図に含める登場人物はTaskごとに異なり、実際に登場したアプリだけを表示する（`task-1`ならAgent Runtime、Agent OP、Resource AS、Resource APIだけで足り、Authorization Platformは登場しない）。

箱の座標は固定して書き下す。同じ系のTaskを2回見る人にとって、絵が毎回同じ場所にあることが「矢印がResource APIの手前で止まった」を認識できる条件だからである（DEC-APP-06）。各箱には名前に加えて、その箱が何をするところかを一行で添える。図の読み方（上段と下段の別、丸が1回のやり取りであること、止められた動きは届かないこと、出ていない箱はこの処理に関わっていないこと）も図の隣に置く。これらは図の凡例であり、個々のイベントの解釈ではない。

**1回のTool呼び出しは1本の矢印ではない。** Agent OPがID-JAGを発行し、Resource ASがそれをAccess Tokenに換え、Resource APIが答える——実際には4往復である。1本の矢印で描くと「Agentが何かに触った」しか言えず、遮断がどこで起きたのかも示せない。そこで発行元が経路を`hops`（[§3.4](#34-activity-record)）として記録し、再生はその1本ずつを順に動かす。経路を知っているのは呼び出した本人であり、画面ではない。

再生は次の順で進む。

1. そのTaskのActivity Eventを`occurred_at`の順に並べ、`hops`を持つイベントはその順に展開する。
2. 1件ずつ、発生元から宛先へ向かう動きを表示し、到達した時点でその`message`を示す。同時に、[§5.4](#54-起きたことの一覧)の対応する行を強調する。
3. `outcome`が`blocked`のものは、宛先の手前で止め、到達させない。同時に`message`（拒否の理由）を示す。`task-2`の例では、Agent RuntimeからResource APIへ向かう動きがTool Executorの位置で止まり、「mail.message.send は許可されたToolに含まれないため、実行を拒否しました」を示す。
4. 全ステップを表示し終えたら、そのTaskの結果（成功／遮断）を静止した状態で残す。

再生の間隔は実際の経過時間に比例させない。Provisioning中のConsent待ちのように数分かかる区間もあれば、Tool呼び出しのように数百ミリ秒で終わる区間もあり、実時間のまま再生すると間延びするか速すぎるかのどちらかになる。1ステップあたり一定の長さで進め、長さそのものは実装時に調整する。

一定の速さで一度流れるだけの再生は、読むものではなく眺めるものになる。人が止まりたいのは、意外なことを言っているステップである。そこで再生・一時停止・次へ・最初から の4操作と、いま何ステップ目かの表示を付ける。押しても記録は変わらない。動かしているのは絵だけである。

一覧の各行は、再生を見る前後どちらでも[§3.1](#31-スキーマ)の`detail`を開けるようにし、技術的な内容はそこで確認できるようにする。

### 5.3 表示のルール

- 一覧・再生のどちらでも、`outcome`が`blocked`の行は`info`や`success`と明確に区別できる見た目にする（色、アイコンなど、具体的な意匠は実装時に決める）。
- `phase`が`security`の`blocked`は、`tool_call`の`blocked`よりさらに強く強調する。前者はプロトコル違反や隔離など攻撃的な操作を示し、後者は権限外の依頼という通常運用でも起こりうる拒否だからである。両者を同じ強さで示すと、日常的な権限エラーのたびに「侵害」のような印象を与えてしまう。
- `detail`は既定で折りたたみ、必要な人だけが技術的な内容（Capabilityの一覧、Policy ID、Finding IDなど）を開けるようにする。
- 一覧はAgentごとに区切る。`provisioning`と`lifecycle`は各Agentの先頭と末尾に固定で並べ、`task-{n}`はその間に完了順で並べる。
- `is_simulated: true`のTaskには常時「デモ実行（模擬）」の表示を付け、実イベントと同じ見た目にはしない（[§6.2](#62-台本で補う)）。

### 5.4 起きたことの一覧

再生の下に、同じイベントを文章として上から並べる。1件ごとに、発生元の箱の名前、時刻、`outcome`のバッジ、`title`、`message`、そして[§3.4](#34-activity-record)のRecordを置く。Recordのうち`checks`は最初から開いておく。「何かに止められたのか」への答えであり、開かないと分からない形にすると読まれないからである。技術的な値（要求、応答、Token の有効期限など）は畳んでおく。

この一覧はサーバー側で描画する。ブラウザが行うのは、再生がいま説明している行に印を付けることだけで、文章は書かない。ブラウザが一文でも作れば、それは立ち会っていない出来事についてブラウザが述べたことになる（RULE-54）。

### 5.5 Agent画面の実行ログ

タイムラインはTaskが終わってから再生する（RULE-59）。だが8手動くAgentを見ている人が、3手を権限外で断られていたことを、終わるまで知れないのは困る。

そこでAgent画面（[02. §5](./02-automation-design.md#5-実行中agentの操作)）に**実行ログ**を置く。読むのはCheckpointであり、Checkpointは1手ごとに書き換わるので、実行中の内容が見える。表示するものは[§3.4](#34-activity-record)の同じRecordであり、タイムラインと同じ記録を別の場所から読んでいるだけである。

この画面はタイムラインではない。`task_id`の行も、再生も持たない。両者が答える問いは違い、混同されると「まだ動いているのに記録が無い」と読まれてしまう。

## 6. 侵害を見せるデモ

権限外の指示や組織ポリシー違反は、Tool ExecutorやPolicy Engineがその場で判定するため、操作した直後にTaskが完了扱いになる。完了してから再生する設計（[§2](#2-基本方針)）にしても、デモの体感速度はほとんど変わらない。

### 6.1 実操作で見せる

次はAgentやTool Executorに実際に操作させ、既存の拒否経路で遮断させる。

| 見せたい状況 | 実際に踏む経路 | 出典 |
|---|---|---|
| 権限外の操作を拒否される | 追加指示で許可されていない作業を指示する | [02. §5](./02-automation-design.md#5-実行中agentの操作)、[04. §7](./04-tool-catalog.md#7-agentに任意httpを許さない) |
| 組織ポリシーで禁止された操作が通らない | 社外ドメイン宛の送信など、Organization Policyに反する作業を依頼する | [03. §2](./03-authorization.md#2-権限の種類)、[03. §6](./03-authorization.md#6-policy-engine) |
| 有効期限切れ後にアクセスできない | `requested_lifetime_minutes`を短く設定したAgentを作り、期限後に追加指示を送る | [07. §4.2](./07-lifecycle.md#42-lifetimeの多層強制)、[07. §6](./07-lifecycle.md#6-expiration--緊急停止) |
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
