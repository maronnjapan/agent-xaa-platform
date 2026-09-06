# 02. 自動化定義（Automation App）

Automation Appは、ユーザーが「AIに何をやってもらうか」をToDoとして書き、作成したAgentを操作するためのアプリである。
画面上の1件のToDoが、本書でいうWork Definitionである（[01. §3.4](./01-overview.md#34-その他の用語)）。
内部に**Automation Design AI**（Vertex AIを呼び出すモジュール）を持つ。

## 1. 基本方針

- 自動化の作成はユーザー起因とする。AIが勝手に自動化内容を最終確定したり、ユーザーの確認なしにAgentを生成したりしない。
- ユーザーの依頼に応じて本システムが日報を作成し、その日報の内容を業務記録、メール、カレンダー、チャット、タスクなどと合わせて分析したうえで、自動化できそうな業務を提案する。
- ユーザーはWeb UI上でAutomation Design AIと対話し、提案内容を確認して自動化対象を決定する。

例：

```text
User:
今までの日報から自動化できそうな業務を提案してほしい

Automation Design AI:
日報の内容から、業務記録の要約作成を自動化候補として提案します。

User:
業務記録を読んで、その日の作業をまとめた日報を作ってほしい。

Automation Design AI:
では「業務記録を読み、当日分の日報を作成して記録する」
という作業内容でAgentを作成します。
```

## 2. Automation Design AIが決めること、決めないこと

| 決めること | 決めないこと |
|---|---|
| 何の作業をするか（Work Definition） | 必要な権限（`document.read` など） |
| ToDo候補、タイトル、説明、実行時のコンテキスト、完了条件、手順、注意点 | どのResourceへアクセスできるか |
| Agentの希望生存時間（分単位、1〜1440分＝最大24時間） | Isolation Level |

### 2.1 ToDoの項目

Agentは人が見ていないところで作業するため、ToDoには「何をするか」だけでなく、作業中に持っていてほしい情報と、いつ終わりかを書く。

| 項目 | 内容 | Agentへ渡るか |
|---|---|---|
| `title` | 何をするか、一言で。Business Work Requestの `purpose` になる | 渡る |
| `description` | 何をしてほしいか。Business Work Requestの `description` になる | 渡る |
| `context` | 実行時のコンテキスト。背景、前提、関係する資料の場所など、Agentが作業中に持っていてほしいこと | 渡る（Authorization Platformへは送らない） |
| `done_criteria` | 完了条件。何ができたら終わりか、1行に1つ | 渡る |
| `steps` | 手順。任せてよければ空でよい | 渡る |
| `notes` | 注意点、やってはいけないこと | 渡る |
| `priority` | `high` / `normal` / `low`。一覧の並び順に使う | 渡る（言葉として） |
| `due_on` | 期限の日付。一覧の並び順と期限切れの表示に使う | 渡る（言葉として） |
| `requested_lifetime_minutes` | Agentの希望生存時間 | Provisioningへ渡る |

権限を書く欄は無い。
`context` はAgentへの最初の指示にだけ載り、Authorization Platformへは送らない。
権限の判断に使うのは `title` と `description` であり、資料の場所や社内の事情を権限決定の入力にしないためである。

### 2.2 ToDoの状態

| 状態 | 意味 | 次へ進めるのは |
|---|---|---|
| `DRAFT` | 下書き。人が直せる、Automation Design AIが書き直せる | 人が「確定」を押す |
| `CONFIRMED` | 内容が固まった。権限を調べ、承認し、Agentを作れる | Agent Provisionerが `agent_id` を返す |
| `IN_PROGRESS` | Agentが実行している。ToDoは `agent_id` を持つ | 人が「完了」か「取り下げ」を押す |
| `DONE` | 人が完了と判断した | 終端 |
| `CANCELLED` | 人が取り下げた | 終端 |

Agentが `TASK_COMPLETED` を報告してもToDoは閉じない。
結果は画面に出し、閉じるのは人である（RULE-08の裏返し）。
Agentが `ACTIVE` の間は取り下げられない。
Agentを止めるのはAgentの画面であり、動いているAgentを残したままToDoだけが「取り下げ」と読める状態を作らないためである。

権限に関する判断はすべてAuthorization Platformが行う（[03. 権限決定](./03-authorization.md)）。
Automation App側は、アクセス可能なResourceやCapabilityの一覧を保持しない。
権限に関する情報をAutomation側へ持ち込まないためである。

## 3. Business Work Request

対話結果は、権限情報を含まない業務要求としてAuthorization Platformへ送る。
送信にはユーザーがHuman IdPで認証して得たHuman Access Token（DPoP-bound、`aud=authorization-platform`）を伴う（[05. §1](./05-identity.md#1-human-identity-provider)）。

```yaml
business_work_request:
  human_subject: user-123
  purpose: daily_work_log_summary
  description: |
    業務記録から当日分を読み取り、
    日報としてまとめて記録する
  constraints:
    external_message_send: false
  requested_lifetime_minutes: 1440
```

`human_subject` はAccess Tokenの `sub` と一致する値だけを受け付ける。
Authorization Platformはボディの値をそのまま信頼せず、`sub` を正として検証する（[05. §1.1](./05-identity.md#11-human_subjectの出どころ)）。

Authorization Platformはこれを Agent Work Definition として構造化し、`operations` や `target_resources` を導出する（[03. §3](./03-authorization.md#3-agent-work-definition)）。

## 4. Agent Definition

Authorization Platformの結果（Effective Capability + Security Profile）を受け取った後、Automation Appはユーザーに内容を提示する。
ユーザーの承認を得てから、Agent ProvisionerへProvisioningを依頼する。
依頼にはHuman Access Token（DPoP-bound、`aud=agent-provisioner`）を伴い、`human_subject` は§3と同じく `sub` を正とする。

```yaml
agent_definition:
  agent_purpose: daily_work_log_summary
  human_subject: user-123

  work_definition:
    description: |
      業務記録を読み、当日分の日報を作成して記録する
    operations:
      - read_documents
      - write_document

  effective_capabilities:
    - document.read
    - document.write

  lifetime:
    max_hours: 24

  security_profile:
    isolation_level: standard
```

高セキュリティの場合：

```yaml
agent_definition:
  agent_purpose: financial_operation
  human_subject: user-456

  work_definition:
    description: |
      承認済みの支払情報を確認し、指定された支払処理を実行する
    operations:
      - inspect_payment
      - approve_payment

  effective_capabilities:
    - finance.payment.read
    - finance.payment.approve

  lifetime:
    max_hours: 24

  security_profile:
    isolation_level: full_isolation
```

## 5. 実行中Agentの操作

Automation Appから、作成済みAgentに対して以下の操作ができる。

| 操作 | 内容 | 実現方法 |
|---|---|---|
| 状況確認 | Agent Status（`CREATED`〜`DESTROYED`）、残り生存時間、実行中のTask、使用したToolと結果の要約 | Agent RuntimeがFirestoreの `agents/{agent_id}/state` へ書くCheckpointを読む |
| 停止 | Agentを即時停止し、Agent Identity Domainを `REVOKED` → `DESTROYED` へ | Lifecycle Managerへ停止を依頼する（[07. §6](./07-lifecycle.md#6-expiration--緊急停止)） |
| 追加指示 | 実行中のAgentへ追加の指示を与える | Firestoreの `agents/{agent_id}/instructions` へ追記し、Agent Runtimeが各ステップの前に読み取る |

状況確認が現在の状態のスナップショットであるのに対し、ログインからAgentの実行までを時系列で追いたい場合は[11. アクティビティタイムライン](./11-activity-timeline.md)を使う。
ToDoの一覧は、そのToDoを実行しているAgentの状態と、Agent Runtimeが出した最後の判定（`TASK_COMPLETED` / `TASK_BLOCKED` / `TASK_FAILED`）を、Agentの画面を開かずに読めるよう並べて出す。

制約：

- 追加指示による処理は、Agent生成時に確定したEffective Agent Permissionを超えてはならない。既存Agentの権限昇格は行わない。追加指示で権限外のToolが必要になった場合、Tool Executorは実行を拒否し、ユーザーへその旨を返す。
- より広い権限が必要な場合は既存Agentを変更せず、ユーザーが新しいAgentを一から作成する（Work Definition再定義 → 権限決定 → 新規Provisioning）。
- これらの操作はHuman Access Token（DPoP-bound）で認証し、`human_subject` がAgentの委譲元ユーザーと一致する場合のみ許可する。操作内容は監査ログへ記録する。

## 6. ToDo登録API

ToDoは画面のほかに、外部のツールからも登録できる。
`/external/todos` は、Human IdPが発行したこのアプリ宛のAccess Tokenを `Authorization: Bearer` で受け取る。
Sessionは見ない。

| 項目 | 内容 |
|---|---|
| 認証 | Human IdPが発行したAccess Token。`typ=at+jwt`、`aud=automation-app`、scopeに `agent:operate` を含む |
| 取得方法 | Human IdPの `automation-app` クライアントで認可コードフローを行い、`agent:operate` スコープを要求する。Human IdPは1つのoperation scopeを1つの `aud` に対応させるため、この要求に対する Access Token は `aud=automation-app` になる（[05. §1](./05-identity.md#1-human-identity-provider)） |
| `human_subject` | Access Tokenの `sub` を正とし、ボディの値は読まない（RULE-43） |
| 断り方 | Tokenが無い・検証できない・`aud` や `typ` が違えば `401` と `WWW-Authenticate: Bearer`。scopeが無ければ `403 insufficient_scope` |

| メソッドとパス | すること | 応答 |
|---|---|---|
| `POST /external/todos` | ToDoを `DRAFT` として登録する。ボディは §2.1 の項目。`title` だけが必須 | `201` と登録したToDo |
| `GET /external/todos` | 自分のToDoの一覧。`?status=` で絞れる | `200` と `{ todos: [...] }` |
| `GET /external/todos/{id}` | 自分のToDo1件。他人のidは `404` | `200` |

```bash
curl -sS -X POST "$AUTOMATION_APP_URL/external/todos" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "未処理の経費申請を確認する",
    "description": "未処理の申請書を読み、10万円を超えるものを一覧にする",
    "context": "申請書は経理フォルダの「未処理」にある。10万円超は上長の確認が要る",
    "done_criteria": ["未処理の申請書がすべて読まれている", "10万円超の一覧が書かれている"],
    "notes": ["承認はしない"],
    "priority": "high",
    "due_on": "2026-09-30",
    "requested_lifetime_minutes": 60
  }'
```

登録できるのは下書きまでである。
確定、権限の承認、Agentの作成はいずれも人がその内容を読んでから押す操作であり（RULE-08）、Tokenを持つプログラムに任せない。
APIから登録したToDoは、画面の一覧に「API から登録」と印が付いて並び、Activity Eventの `detail.source` にも `api` が入る。

このAPIはDPoP証明を要求しない。
`automation-app` はRULE-06がDPoPを求める3つのControl Plane audienceに含まれず、画面のSessionと同じ検証（署名、`typ`、`aud`、`sub`、scope）で受け付ける。

## 付録 A. Google Bridge を有効にした場合の例

この付録は `enable_google_bridge=true` のときだけ成り立つ。
既定の apply では Bridge も stub SaaS も作られないため、本文の例は外部SaaSを使わないものにしてある。

外部SaaSを含める場合、対話と要求は次の形になる。

```text
User:
Google Calendarを確認して、重要な予定を整理してほしい。

Automation Design AI:
では「Google Calendarから予定を取得し、重要な予定を整理する」
という作業内容でAgentを作成します。
```

```yaml
business_work_request:
  human_subject: user-123
  purpose: daily_schedule_analysis
  description: |
    Google Calendarから当日の予定を取得し、
    重要な予定を抽出して整理する
  constraints:
    external_message_send: false
  requested_lifetime_minutes: 1440
```

```yaml
agent_definition:
  agent_purpose: daily_schedule_notification
  human_subject: user-123

  work_definition:
    description: |
      Google Calendarから予定を取得し、重要な予定を整理する
    operations:
      - retrieve_calendar_events
      - analyze_events

  effective_capabilities:
    - calendar.event.read

  lifetime:
    max_hours: 24

  security_profile:
    isolation_level: standard
```

外部SaaSのAccess TokenはOAuth Bridgeが保持し、Agentへは渡らない（[06. OAuth Bridge](./06-oauth-bridge.md)）。

