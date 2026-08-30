# 09. セキュリティ監視（Security Detection）

Security Detectionは、Identity、Authorization、Token、Tool、APIの各ログからAgentの異常を検知し、Lifecycle Managerへ隔離や失効を依頼するアプリである。
アプリの配置と権限は [08. §2](./08-gcp-infrastructure.md#2-デプロイ単位と内部機能) と [08. §5](./08-gcp-infrastructure.md#5-service-account一覧) を参照。

## 1. 基本方針

すべてのログをLLMへ直接送ることはしない。
機械的に判定できるものは機械が判定し、AIには相関済みのSecurity Findingだけを渡す。

```mermaid
flowchart TB
    SRC[Identity / Authorization / Token / API / Agent Logs]
    COLLECT[Telemetry Collection]
    NORMALIZE[Normalization]
    PROTO[Protocol Validation]
    RULE[Rule-based Detection]
    CORR[Correlation]
    SCORE[Risk Scoring]
    FIND[Security Finding]
    AI[Security AI Analysis]
    RESP[Response]
    HUMAN[Human Review]
    STORE[Store / Observe]

    SRC --> COLLECT --> NORMALIZE --> PROTO --> RULE --> CORR --> SCORE
    SCORE -->|Low| STORE
    SCORE -->|Medium / High| FIND --> AI --> RESP
    RESP -->|Ambiguous| HUMAN
```

## 2. 収集するログ

各アプリが出すログのうち、検知に使う項目を示す。
すべてのログに `human_subject`、`agent_id`、`trace_id`、`timestamp` を含める。

| 発生源 | 項目 |
|---|---|
| Human IdP | Client ID、audience、scope、認証結果、DPoP検証結果、送信元IP、デバイス情報 |
| Authorization Platform（Authorization AI Agent） | Agent Draft ID、Work Definition IDとそのHash、推論したCapability、Confidence、Capability Taxonomyのバージョン、AIモデルのバージョン |
| Authorization Platform（Policy Engine） | Proposed Capability、Effective Capability、Security Profile、Isolation Level、ALLOW / DENY、Policy ID、Decision Reason |
| Agent Provisioner | Issuer、Isolation Level、Dedicated OPの有無、Provisioned Tool、Provisioned XAA Connection（audience、resource、scope）、外部Connectorの状態、created / expires / destroyed |
| Agent OP | OP Runtime ID、Shared / Dedicated、ID-JAG要求（audience、resource、scope）、発行結果、期限確認結果、grant type、client ID、エラーコード |
| Google Bridge | ID-JAG issuerと検証結果、Connection ID、要求されたresourceとscope、Agent期限の検証結果、Google Token Refreshの結果、Access Token払い出し結果 |
| Native Resource AS | ID-JAG issuerとsubject、audience、resource、scope、Token発行結果、認可判定、Agent期限の検証結果 |
| Resource API / Google API（取得できる場合） | Tool ID、API operation、HTTP Method、Resource、Response Status、実行結果、Latency |
| Agent Runtime | Task ID、Execution ID、Tool ID、要求した操作、対象Resource、結果、Agent Age、expires_at、Span ID |

Work Definitionの全文は無条件にSecurity AIへ送らない。
必要な場合はHash、構造化した操作種別、Capabilityの結果を使う。

## 3. ログへ残さないもの

| 残さないもの | 相関に使う代替 |
|---|---|
| Raw Access Token、Raw ID-JAG、Raw DPoP Proof | `jti`、Token fingerprint |
| Refresh Token、Private Key、Client Secret、Authorization Code | key thumbprint、`connection_id` |
| （上記のいずれにも該当しない相関キー） | `request_id`、`trace_id` |

## 4. 正規化と保存

各アプリ固有のログはそのままAIへ送らず、共通のEvent Schemaへ正規化する。
Schemaには、OCSFのようなVendor非依存のSecurity Schemaを採用することを検討する。

保存経路は次の一方向のみとする。

```text
各アプリ → Cloud Logging → Log Sink / Pub/Sub → agent-security-prod（BigQuery）
```

Platform側のService AccountにはSecurity Project上のログを削除する権限を与えない（[08. §1](./08-gcp-infrastructure.md#1-gcp-projectの構成)）。

## 5. 検知の段階

### 5.1 Protocol Validation

次の違反はAI分析ではなく、受信した時点で機械的に判定する。

```text
Invalid Signature / Expired Token / Expired Agent
audience mismatch / resource mismatch / invalid scope
unknown issuer / invalid client / invalid ID-JAG
invalid DPoP Proof / replayed DPoP Proof / DPoP key binding mismatch (cnf.jkt)
human_subject mismatch (body vs token sub)
unauthorized Tool
expired Bridge Connection / expired XAA Connection
```

### 5.2 Rule-based Detection

第一段階ではAIを使わず、閾値と条件で検出する。

| 分類 | 例 |
|---|---|
| Token | Token要求の急増。ID-JAGの大量発行。Google Token Refresh失敗の急増。認証失敗の急増 |
| Authorization | 大量の401 / 403。異常なscope要求。未知のaudienceやresource |
| Tool | 未知のToolの利用。ProvisioningされていないToolの実行。普段使わないResourceへのアクセス |
| Lifetime | Agent Lifetimeの超過。期限後のアクセス |
| Isolation | Cross-Agent IdP Access。Dedicated OPから別AgentのIssuerで発行しようとする試み。Dedicated OPから他AgentのConfigへのアクセス |
| Authorization AI | 存在しないCapabilityの生成。Capability Taxonomy外の権限生成。AI結果とPolicy Decisionの異常な乖離 |

### 5.3 Correlation

単一のイベントでは判断できないものをまとめ、1つのFindingにする。

```text
10:00  Agent A  unknown audience request
10:01  Agent A  Agent B のOPへアクセス
10:02  Agent A  ID-JAG request x 100
10:03  Agent A  API 403 x 50
        ↓
Finding: Potential Agent Compromise（Agent A）
```

Correlationは複数Agentを横断して行う。
Agent AからAgent B、C、DのOPへの横方向アクセスは、Agent単体のログでは見えず、中央でまとめて初めて検出できる。
Agent OPやAgent Runtimeの内部には軽量なRule Engineだけを置き、重い判定ロジックは持たせない。

### 5.4 Agent Baseline

AI Agentは業務用途が限定されるため、人間よりBaselineを作りやすい。
ただし最大Lifetimeが24時間であるため、長期の履歴ではなく、Agent Definitionから期待値を導く。

| Baselineの根拠 | 例（Agent A） |
|---|---|
| Effective Capability | `calendar.event.read`、`mail.message.send` |
| Expected Tools | `google.calendar.events.list`、`google.gmail.message.send` |
| Expected Resources | Google Calendar、Gmail |
| Expected Rate | ID-JAG 2〜20回、API Request 10〜100回 |
| Lifetime | 24時間以内 |
| Current Session Behavior | 現在のExecutionでの実際の挙動 |

Baselineからの逸脱として扱う例：通常使わないTool、Effective Capabilityに存在しないTool、未知のResource、ID-JAG 500回、別Agent OPへのアクセス、期限後のアクセス。

### 5.5 Risk Score

| Score | Level |
|---|---|
| 0〜29 | LOW |
| 30〜59 | MEDIUM |
| 60〜79 | HIGH |
| 80〜100 | CRITICAL |

Scoreの要素：Protocol Violation、Authorization Violation、Authorization AI Anomaly、Behavior Deviation、Token / API Request Rate、Resource Sensitivity、Cross-Agent Activity、DPoP Failure、Privilege Escalation Attempt、Agent Expiration Violation、Isolation Boundary Violation。

LOWは保存と観測にとどめ、MEDIUM以上をSecurity Findingとして次の段階へ渡す。

### 5.6 Security AI Analysis

AIへ渡すのはRaw Logではなく、次の要約情報である。

```text
Security Finding / Risk Score / Related Events
Agent Baseline / Agent Definition / Work Definition Summary
Authorization AI Proposed Capability / Effective Capability / Allowed Tools
Isolation Level / Relevant Authorization Decisions
audience / resource / scope / Agent Age / Time Series
```

AIに期待する出力は次のとおり。

| 観点 | 内容 |
|---|---|
| 逸脱 | 通常挙動との差。Authorization AI推論およびEffective Capabilityとの整合性 |
| 判断 | 侵害の可能性。誤検知の可能性。関連イベントの因果関係 |
| 影響 | 影響範囲。Shared / Dedicated OPへの波及 |
| 推奨 | 推奨するResponseとConfidence |

## 6. Response

Findingに応じて、Security DetectionはLifecycle Managerへ次のいずれかを依頼する。

```text
ACTIVE → SUSPICIOUS → QUARANTINED → REVOKED → DESTROYED
```

QUARANTINEDではAgent OPの新規ID-JAG発行を止め、REVOKED以降は [07. §6](./07-lifecycle.md#6-expiration--緊急停止) のCleanupを実行する。
判断が曖昧な場合はHuman Reviewへ回す。
侵害時の影響範囲がIsolation Levelでどう変わるかは [05. §5](./05-identity.md#5-isolation-model) を参照。
