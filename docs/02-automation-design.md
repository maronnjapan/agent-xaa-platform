# 02. 自動化定義（Automation App）

Automation Appは、ユーザーが「何を自動化するか」を決め、作成したAgentを操作するためのアプリである。
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
| 自動化候補、業務内容、処理順序、ユーザー確認事項、安全上の注意 | どのResourceへアクセスできるか |
| Agentの希望生存時間（分単位、1〜1440分＝最大24時間） | Isolation Level |

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

制約：

- 追加指示による処理は、Agent生成時に確定したEffective Agent Permissionを超えてはならない。既存Agentの権限昇格は行わない。追加指示で権限外のToolが必要になった場合、Tool Executorは実行を拒否し、ユーザーへその旨を返す。
- より広い権限が必要な場合は既存Agentを変更せず、ユーザーが新しいAgentを一から作成する（Work Definition再定義 → 権限決定 → 新規Provisioning）。
- これらの操作はHuman Access Token（DPoP-bound）で認証し、`human_subject` がAgentの委譲元ユーザーと一致する場合のみ許可する。操作内容は監査ログへ記録する。

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

