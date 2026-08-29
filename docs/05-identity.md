# 05. Identity（Human IdentityとAgent Identity）

本書は「誰であるか」を扱う。
Part Aは人間の認証（Human IdP、DPoP）、Part BはAgentの認証（Agent OP、Agent Registration、Isolation Model、Cross App Access）である。
GCP上のアプリの身元であるGCP Service Accountは [08. §4](./08-gcp-infrastructure.md#4-gcp-service-accountとは) を参照。

---

## Part A：Human Identity

### 1. Human Identity Provider

人間ユーザーの認証を担当する。
OIDC / OAuthを利用する。

Human IdPは、Control Planeの各アプリ向けにAccess Tokenを発行する。

| 発行するToken | 用途 | aud |
|---|---|---|
| ID Token | Automation Appへのログイン | automation-app |
| Access Token | Authorization Platform API呼び出し | authorization-platform |
| Access Token | Agent Provisioner API呼び出し | agent-provisioner |

APIアクセスにはID TokenではなくAccess Tokenを使う。

### 2. DPoP

Human IdPからControl Planeへ渡すAccess Tokenは、Bearer TokenではなくDPoP-bound Access Tokenを優先する。

目的：

```text
Stolen Access Token + DPoP Private Keyなし = 利用不可
```

適用範囲：

| 経路 | DPoP |
|---|---|
| Human IdP → Automation App → Authorization Platform / Agent Provisioner | 必須 |
| Agent → Resource Authorization Server / Bridge / Resource API | 必須にしない。接続先の仕様に従い Bearer / DPoP / mTLS などを許容する（外部SaaSがDPoPに対応している保証がないため） |

```mermaid
sequenceDiagram
    actor U as Human User
    participant HIDP as Human IdP
    participant APP as Automation App
    participant AUTHZ as Authorization Platform
    participant PROV as Agent Provisioner

    U->>HIDP: OIDC Login + DPoP Key
    HIDP-->>APP: ID Token
    HIDP-->>APP: DPoP-bound Access Token (aud=authorization-platform)
    APP->>AUTHZ: Access Token + DPoP Proof
    AUTHZ->>AUTHZ: Validate Token + Proof
    HIDP-->>APP: DPoP-bound Access Token (aud=agent-provisioner)
    APP->>PROV: Access Token + DPoP Proof
    PROV->>PROV: Validate Token + Proof
```

---

## Part B：Agent Identity

### 3. Agent OP

Agent OPは**AgentのOpenID Provider**であり、Agent Identityそのものを表す。
Agent Runtimeからの要求に応じてID-JAGを発行する。

Agent OPが持つもの：

| 分類 | 内容 |
|---|---|
| Identity Profile | issuer、subject、token_endpoint、jwks_uri、signing key reference（Cloud KMS）、supported algorithms / grant types、client information |
| XAA Static Configuration | allowed audience、resource、scope、trusted Resource Authorization Server、expires_at |

Identity ProfileとXAA Static Configurationは概念上分離する。
どちらもProvisioning時に確定して静的に注入し、生成後に外部Registryへ問い合わせて動的に決めることはしない。

Agent OPが持たないもの：自然言語、業務説明、Human Permission DB、Authorization AI、Policy Decision Logic、SaaS Discovery Logic、API仕様、Google Refresh Token / Client Secret、業務AIロジック。

Agent OPは判断しない。
仕事は以下のみである。

```text
Agent Authentication
preconfigured XAAの実行（ID-JAG発行）
Token署名（Cloud KMS）
Agent Expiration確認
```

### 4. Agent Registration（STANDARDでもAgentごとに作る）

Shared Agent OPで共有されるのは**OPのプロセス（Cloud Run Service）だけ**である。
Agentが認証を受けるための「アカウント」に相当する**Agent Registration**は、Isolation Levelに関わらずAgentごとに必ず作成する。

Agent Registrationの内容（Firestore `agents/{agent_id}`）：

```json
{
  "agent_id": "agent-001",
  "human_subject": "user-123",
  "issuer": "https://shared-agent-op.example.com/agents/agent-001",
  "subject": "agent-001",
  "signing_key": "projects/.../cryptoKeys/agent-001-key",
  "client_id": "agent-001",
  "client_auth": {
    "method": "private_key_jwt",
    "jwk_thumbprint": "..."
  },
  "allowed_audiences": ["https://google-bridge.example.com"],
  "resources": ["google-calendar"],
  "scopes": ["calendar.read"],
  "created_at": "2026-08-29T10:00:00+09:00",
  "expires_at": "2026-08-30T10:00:00+09:00",
  "status": "ACTIVE"
}
```

つまり各Agentは、Shared OP上でも issuer / subject / signing key / client credential / XAA config / expires_at をすべて個別に持つ。
Agent AのRegistrationでAgent BのID-JAGを発行することはできない。

Agent RuntimeがAgent OPへID-JAGを要求するときの認証は2層とする。

| 層 | 何を確認するか | 仕組み |
|---|---|---|
| Layer 1：Cloud Run IAM | このワークロードはAgent OPを呼び出してよいか | Agent RuntimeのGCP Service Accountに `run.invoker` を付与 |
| Layer 2：Agent Client Credential | このAgentはこのRegistrationの持ち主か | Provisioningで生成したAgent専用の鍵で `private_key_jwt` によるClient認証 |

Agent Client Credentialは、Provisionerが生成してOPへ登録し、Cloud Run Job Executionの環境変数オーバーライドで当該Executionにのみ渡す。
`expires_at` で失効し、Checkpointへは保存しない。

GCP IAMはXAAの代替ではない。
Layer 1は「どのアプリが呼べるか」、Layer 2は「どのAgentとしてID-JAGを発行するか」であり、役割が異なる。

### 5. Isolation Model

Security Profileに応じて、Agent OPとRuntimeをどこまで物理分離するかを2段階で定める。

| | **STANDARD** | **FULL_ISOLATION** |
|---|---|---|
| 対象 | 通常Agent | 高セキュリティAgent（financial、admin、sensitive write等） |
| Agent OP プロセス | Shared Agent OP（Cloud Run Service共有） | Agent専用Cloud Run Service `dedicated-op-<agent>` |
| Agent Registration | Agentごと | Agentごと |
| Signing Key（KMS） | Agentごと | Agentごと（専用OP SAのみ署名可） |
| XAA Static Config | Agentごと | Agentごと |
| Agent Runtime | Agentごとに1 Cloud Run Job Execution（Job定義とSAは共有） | Agent専用Job定義 + 専用SA `sa-agent-<agent>` |
| IAM Binding | 共有（`sa-agent-runtime` → `shared-agent-op`） | Agent専用（`sa-agent-<agent>` → `dedicated-op-<agent>` のみ） |
| Bridge / XAA Connection | Agent単位のBinding | Agent単位のBinding（専用Connection） |
| Network Policy | 共通 | 必要に応じて専用 |

いずれのLevelでも 1 Agent = 1 Cloud Run Job Execution であり、複数のAgentが1つのプロセスで動くことはない。
共有されるのは「OPのプロセス」と「RuntimeのJob定義とGCP Service Account」であって、Agentの実行そのものや身元ではない。

#### なぜ2段階か（DEDICATED_IDENTITYを廃止した理由）

以前の版では中間段階として「Dedicated OPのみ作り、Runtimeは共有」する `DEDICATED_IDENTITY` を置いていたが、以下の理由で廃止した。

1. **分離の効果が中途半端**：Dedicated OPを作っても、共有Runtime SAからそのOPを呼べる状態では、他Agentの侵害されたRuntimeからDedicated OPへID-JAGを要求できてしまう。OPを分離するなら、それを呼べるRuntime SAとIAM Bindingも同時に分離しないと意味がない。
2. **コスト差がほぼない**：FULL_ISOLATIONで追加されるのはCloud Run Job定義、Service Account、IAM Bindingであり、いずれも無料である。費用が発生するのはDedicated OPのCloud Run Serviceであり、これは両者に共通する。
3. **Runtimeは元々Agentごと**：1 Agent = 1 Job Executionであるため「Runtime共有」という区別自体が弱い。
4. **分岐が減る**：Policy Engineの決定、Provisionerの分岐、Cleanup処理、テストがそれぞれ2通りで済む。

必要になった場合は、Provisioningがテンプレートベースであるため後から中間段階を追加できる。

#### FULL_ISOLATIONの例

```text
Agent finance-001
├ Cloud Run Service   dedicated-op-finance-001
├ Service Account     sa-op-finance-001         （finance-001-signing-keyでの署名のみ許可）
├ Cloud KMS Key       finance-001-signing-key
├ Agent Config        finance-001 only
├ Cloud Run Job       agent-runtime-finance-001
├ Service Account     sa-agent-finance-001      （dedicated-op-finance-001 のinvokeのみ許可）
└ Bridge Connection   finance-001 binding
```

`sa-op-finance-001` には以下を付与する。

```text
ALLOW  finance-001-signing-keyで署名 / finance-001-config読み取り
DENY   他AgentのKey / shared-agent keys / Google Refresh Token / Authorization DB write / Provisioner権限
```

Dedicated OPに専用のService Accountが必要なのは、GCP IAMでKMS鍵への署名権限を「このOPだけ」に絞るためである。
Shared OPのSAを流用すると、そのSAが持つ全Agentの鍵に署名できてしまい、分離の意味がなくなる。

#### Blast Radius

| 侵害箇所 | STANDARD | FULL_ISOLATION |
|---|---|---|
| Agent A のRuntime | Agent AのIdentity / Key / Config / Connection | 同左 |
| Agent A のOP | Shared OPプロセスの侵害 → 全STANDARD Agentの鍵で署名できる可能性 | Agent Aのみ |
| Agent A のRuntime SA | 共有SA → Shared OPへの呼び出し権限（Layer 2でAgentは区別される） | Agent Aのみ |

Shared OPプロセスの侵害が複数Agentへ波及し得ることがSTANDARDの許容リスクであり、それを許容できないAgentがFULL_ISOLATIONになる。

#### Provisioning分岐

```mermaid
flowchart TB
    PERM[Effective Capability] --> PROV[Agent Provisioner]
    TOOL[Tool / Connector Catalog] --> PROV
    RISK[Security Profile] --> PROV
    PROV --> ID[Generate Agent ID]
    ID --> KEY[Generate Signing Key + Client Credential]
    KEY --> XAA[Generate Static XAA Configuration]
    XAA --> CLASS{Isolation Level}
    CLASS -->|STANDARD| SHARED[Register Agent in Shared OP]
    CLASS -->|FULL_ISOLATION| DEDICATED[Deploy Dedicated OP + Dedicated Runtime + IAM]
```

### 6. Cross App Access

本システムの主要なResource Accessモデルである。

```text
Agent → Agent OP → ID-JAG → Resource Authorization Server → Access Token → Resource API
```

ID-JAGに含める3つの概念を区別する。

| 項目 | 意味 | Native XAA例 | Google Bridge例 |
|---|---|---|---|
| audience | ID-JAGを受け取るResource Authorization Server | `https://customer-auth.example.com` | `https://google-bridge.example.com` |
| resource | 最終的にアクセスするProtected Resource | `https://customer-api.example.com` | `google-calendar` |
| scope | Resource上で許可する操作 | `customer.read` | `calendar.read` |

Google Bridgeの場合、BridgeがこのID-JAGを認可材料としてGoogle Access TokenをBrokerする。

### 7. Native XAA Runtime Flow

Resource Authorization Server自身がID-JAGを理解する場合のフローである。
Bridgeは存在しない。

```mermaid
sequenceDiagram
    participant AI as Agent Reasoning
    participant TOOL as Tool Executor
    participant OP as Agent OP
    participant AS as Resource Authorization Server
    participant API as Resource API

    AI->>TOOL: internal.customer.list
    TOOL->>TOOL: Load Tool Manifest / Check Allowed Tools
    TOOL->>OP: ID-JAG Request (client auth + audience/resource/scope)
    OP->>OP: Validate Agent Registration + Lifetime
    OP-->>TOOL: ID-JAG
    TOOL->>AS: ID-JAG
    AS->>AS: Validate ID-JAG
    AS-->>TOOL: Access Token
    TOOL->>API: API Request + Access Token
    API-->>TOOL: Response
    TOOL-->>AI: Structured Result
```

### 8. OAuth Bridge Runtime Flow

Googleなど、ID-JAGを理解しない外部SaaSの場合のフローは [06. §4](./06-oauth-bridge.md#4-runtime-flow) を参照。

### 9. Tokenの種類と保持ルール

| Token | 発行者 | 用途 | 備考 |
|---|---|---|---|
| Human ID Token | Human IdP | Human Authentication | |
| Human Access Token | Human IdP | Control Plane API | DPoP-bound |
| ID-JAG | Agent OP | AgentのCross App Access用Identity Assertion | |
| Native Resource Access Token | Native Resource AS | Resource API呼び出し | |
| SaaS Access Token | 外部OAuth AS（Google等） | SaaS API呼び出し | Bridge経由でAgentへ払い出す |

AgentがRuntimeで保持してよいもの：ID-JAG、Resource Access Token、Google Access Token等の短期Token、Task Execution Context。
Access Tokenは原則としてメモリのみ、永続化なし、短期とする。

Agentが保持しないもの：Human Access Token、Google Refresh Token、OAuth Client Secret、Private Key（署名はCloud KMSで行う）、長期の外部Credential。
