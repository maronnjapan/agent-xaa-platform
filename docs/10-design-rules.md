# 10. 設計ルール

各文書で決めた原則を、参照しやすいように一覧にする。
ルールの根拠と詳細は「出典」の節にあり、本書はそれを繰り返さない。

## Identity

| ID | ルール | 出典 |
|---|---|---|
| RULE-01 | Human IdentityとAgent Identityを分離する。AgentはHuman Userの代理として動作する独立したIdentityである | [01. §2](./01-overview.md#2-基本思想) |
| RULE-02 | Agent RuntimeはHuman Sessionと独立して存在する。ユーザーの対話セッションが終わってもAgentは生存期間内で実行を続ける | [01. §2](./01-overview.md#2-基本思想) |
| RULE-03 | Agent Registration（client credential、XAA config、Human IdP Connection、expires_at）はIsolation Levelに関わらずAgentごとに作る | [05. §4](./05-identity.md#4-agent-registrationstandardでもagentごとに作る) |
| RULE-04 | 1 Agent = 1 Cloud Run Job Execution とする。複数のAgentを1つのプロセスで動かさない | [07. §4.1](./07-lifecycle.md#41-実行形態) |
| RULE-05 | GCP Service AccountはアプリがGCP IAMに対して名乗る身元であり、Agentの身元ではない。Agentの身元はID-JAGである | [08. §4](./08-gcp-infrastructure.md#4-gcp-service-accountとは) |
| RULE-06 | Human Control PlaneのAccess TokenはDPoP-boundとする。Agent RuntimeからAgent OPへのToken ExchangeとNative Resource ASへの提示でもDPoPを必須とし、ID-JAGを `cnf.jkt` で束縛する。外部SaaSへの接続だけは相手の仕様に従う | [05. §2](./05-identity.md#2-dpop) |
| RULE-43 | Control Plane APIの `human_subject` はAccess Tokenの `sub` を正とする。リクエストボディの値をそのまま信頼しない | [05. §1.1](./05-identity.md#11-human_subjectの出どころ) |
| RULE-44 | DPoP検証では、Access Tokenの `cnf.jkt` とDPoP Proofの鍵の一致を必ず確認する。Proofが添付されていることの確認だけで済ませない | [05. §2.1](./05-identity.md#21-受け取り側の検証手順) |

## 権限決定

| ID | ルール | 出典 |
|---|---|---|
| RULE-07 | Automation Design AIはWork Definitionを定義する。権限、アクセス可能なResource、Capabilityの情報をAutomation App側に持たせない | [02. §2](./02-automation-design.md#2-automation-design-aiが決めること決めないこと) |
| RULE-08 | ユーザーとの対話と承認なしに、Automation Design AIがWork Definitionを最終確定したりAgentを生成したりしない | [02. §1](./02-automation-design.md#1-基本方針) |
| RULE-09 | Authorization AI AgentはWork DefinitionからAbstract Capabilityを推論する。出力はCapability Taxonomy内に制限し、API Endpoint、HTTP Method、OAuth Scope、Bridge URLを生成しない | [03. §4](./03-authorization.md#4-authorization-ai-agent) |
| RULE-10 | Authorization AI Agentの出力は提案であり、最終的なAuthorization DecisionはPolicy Engineが行う | [03. §1](./03-authorization.md#1-位置づけ) |
| RULE-11 | Effective Agent Permission = Proposed Capability ∩ Human Permission ∩ Delegatable Permission ∩ Organization Policy ∩ Risk Policy とし、常にHuman Permissionを超えない | [03. §2](./03-authorization.md#2-権限の種類) |
| RULE-12 | 最低Isolation LevelはPolicy EngineがRisk Policyで決定する。Authorization AI Agentは補助情報を提案してよい | [03. §7](./03-authorization.md#7-security-profile) |
| RULE-13 | 既存Agentの権限昇格は行わない。より広い権限が必要なら、ユーザーが新しいAgentを一から作成する | [02. §5](./02-automation-design.md#5-実行中agentの操作)、[07. §7.1](./07-lifecycle.md#71-agent自身の作業内容権限を変えたい場合) |
| RULE-14 | Human Permissionが縮小したら既存Agentを再評価し、Re-Provisioningする。拡大は既存Agentへ反映しない | [07. §7.2](./07-lifecycle.md#72-human-userの権限が変更された場合re-provisioning) |

## CapabilityとTool

| ID | ルール | 出典 |
|---|---|---|
| RULE-15 | CapabilityとToolを分離する。Capability ≠ API Endpoint | [03. §5](./03-authorization.md#5-抽象capability) |
| RULE-16 | Toolの認証方式、接続先、API Endpointは Tool / Connector Catalog で管理する。Agent OPとAuthorization Platformはこの情報を持たない | [04. §1](./04-tool-catalog.md#1-tool--connector-catalogとは) |
| RULE-17 | AgentはProvisioning済みのToolだけを選択する。任意のURL、Method、scope、audienceを生成させない | [04. §7](./04-tool-catalog.md#7-agentに任意httpを許さない) |
| RULE-18 | AI（LLM）はToolを選び、認証とAPI実行はDeterministic Tool Executorが行う | [04. §6](./04-tool-catalog.md#6-tool-executor) |

## Cross App AccessとBridge

| ID | ルール | 出典 |
|---|---|---|
| RULE-19 | XAA設定（audience、resource、scope）はProvisioning時に確定してAgent OPへ静的に注入する。Agent生成後にRegistryへ問い合わせて動的に決めない | [05. §3](./05-identity.md#3-agent-op)、[07. §3.1](./07-lifecycle.md#31-provisioning時にすべて確定する) |
| RULE-20 | Agent OPは判断しない。仕事はAgent認証、`subject_token` と `actor_token` の検証、静的XAA設定との照合、ID-JAG発行とKMS署名、期限確認、`subject_token` の払い出しのみ | [05. §3.4](./05-identity.md#34-agent-opが持つもの持たないもの) |
| RULE-21 | Native XAA ResourceではBridgeを使わない。BridgeはID-JAGを理解しない外部OAuth SaaS向けの互換レイヤーとしてのみ使う | [06. §1](./06-oauth-bridge.md#1-位置づけ) |
| RULE-22 | Refresh TokenとClient SecretをAgent Runtimeへ渡さない。Runtimeへ渡してよいのは、XAA用のID Token、短期Access Token、当該Execution限りのCredentialだけとする | [05. §9](./05-identity.md#9-tokenの種類と保持ルール)、[06. §3](./06-oauth-bridge.md#3-credential保持方針) |
| RULE-23 | OAuth Redirectで `access_token` や `refresh_token` を渡さない。返すのは `transaction_id` とone-time codeのみ | [06. §5](./06-oauth-bridge.md#5-google-consent) |
| RULE-24 | Bridge ConnectionはHuman Userごと、Agent BindingはAgentごとに持つ。BindingはAgent破棄時に必ず削除する | [06. §3](./06-oauth-bridge.md#3-credential保持方針) |
| RULE-45 | Cross App Accessは `draft-ietf-oauth-identity-assertion-authz-grant` に準拠する。逸脱する箇所は、逸脱していることと相互運用を期待しない範囲を文書に明示する | [05. §3.1](./05-identity.md#31-cross-app-accessにおける役割の対応) |
| RULE-46 | ID-JAGの `sub` は委譲元の人間、`act` は代理として動くAgentとする。Agentを `sub` に置かず、`client_id` でAgent個体を表さない | [05. §6.4](./05-identity.md#64-id-jag) |
| RULE-47 | Human IdPにAgentの文脈を持ち込まない。issuerは1つに保ち、人間の文脈とAgentの文脈はパスでデプロイを分ける | [05. §3.2](./05-identity.md#32-issuerを分けずデプロイだけ分ける理由) |
| RULE-48 | Agent OPのID-JAG署名鍵はHuman IdPのSSO署名鍵と別鍵とし、`typ` が `oauth-id-jag+jwt` のJWT以外を署名しない | [05. §3.3](./05-identity.md#33-agent-op署名鍵の制約) |
| RULE-49 | Token Exchangeでは、`actor_token` が指すAgent Registrationの `human_subject` と `subject_token` の `sub` の一致を必ず確認する。有効な `subject_token` に無関係な `actor_token` を組み合わせられないようにする | [05. §6.3](./05-identity.md#63-agent-opの検証手順) |
| RULE-50 | Agentごとのクライアント登録を作らない。`client_id` は `agent-platform` 1つとし、Agent個体は `cnf.jkt` と `act` と監査ログで識別する | [05. §6.5](./05-identity.md#65-agentごとのクライアント登録を作らない理由) |
| RULE-51 | Human IdP ConnectionのRefresh TokenはAgent OPだけが保持する。Agentごとに作り、`expires_at` を超えず、Cleanupで必ずRevokeする | [05. §4.1](./05-identity.md#41-human-idp-connection) |
| RULE-52 | 各Resource ASにおける `agent-platform` の登録scopeは、そのResource ASで必要な最小に保つ。ID-JAG署名鍵が漏れた場合の上限がこの値になる | [05. §3.3](./05-identity.md#33-agent-op署名鍵の制約) |

## Lifecycle

| ID | ルール | 出典 |
|---|---|---|
| RULE-25 | Agentの最大生存期間は24時間とする | [07. §1](./07-lifecycle.md#1-agent-lifetime) |
| RULE-26 | LifetimeはCloud Run timeoutだけに依存せず、Identity、Authorization、Connectionの各層でも強制する | [07. §4.2](./07-lifecycle.md#42-lifetimeの多層強制) |
| RULE-27 | 期限到達、ユーザーによる停止、異常検知のいずれでもAgent Identity Domain全体をCleanupする。Agent OPの削除だけで終わらせない | [07. §6](./07-lifecycle.md#6-expiration--緊急停止) |
| RULE-28 | Human Identityが無効化されたら、そのユーザーの全Agentを即時Revokeする | [07. §7.3](./07-lifecycle.md#73-human-userの退職無効化) |
| RULE-29 | Agent OPとRuntimeはDisposableとし、更新より作り直しを優先する | [07. §5](./07-lifecycle.md#5-disposable設計) |

## Isolation

| ID | ルール | 出典 |
|---|---|---|
| RULE-30 | Isolation LevelはSTANDARDとFULL_ISOLATIONの2段階とする | [05. §5](./05-identity.md#5-isolation-model) |
| RULE-31 | STANDARDはShared OPのプロセスを共有してよい。ただしRegistration、Signing Key、XAA ConfigはAgent単位で分離する | [05. §4](./05-identity.md#4-agent-registrationstandardでもagentごとに作る) |
| RULE-32 | FULL_ISOLATIONはDedicated OP、専用Service Account、専用KMS Key、専用Job定義、専用IAM Bindingを持つ | [05. §5](./05-identity.md#5-isolation-model) |
| RULE-33 | Dedicated OPのService Accountは、そのAgentの鍵にだけ署名できる | [08. §4.2](./08-gcp-infrastructure.md#42-dedicated-opにservice-accountを分ける理由) |

## GCP

| ID | ルール | 出典 |
|---|---|---|
| RULE-34 | 実行系は `agent-platform-prod` に集約し、監査ログの保存だけを `agent-security-prod` へ分離する | [08. §1](./08-gcp-infrastructure.md#1-gcp-projectの構成) |
| RULE-35 | 責務分離はService Account、IAM、KMS Key、Secret、DB Userで行う。アプリごとに専用のService Accountを作り、デフォルトService Accountを使わない | [08. §4](./08-gcp-infrastructure.md#4-gcp-service-accountとは)、[08. §5](./08-gcp-infrastructure.md#5-service-account一覧) |
| RULE-36 | Cloud Run IAMはXAAの代替ではない。IAMは「どのアプリが呼べるか」、ID-JAGは「どのAgentとして何にアクセスできるか」を決める | [08. §8](./08-gcp-infrastructure.md#8-ネットワークと公開範囲) |
| RULE-37 | Internetへ公開するのは、Automation App、Google BridgeとAgent OPのOAuth Callback、issuerのメタデータとJWKSだけとする | [08. §8](./08-gcp-infrastructure.md#8-ネットワークと公開範囲) |
| RULE-53 | 共有JWKSはアプリではなくCloud Storageから配信し、各アプリには自分の鍵の書き込みだけを許す | [08. §2.1](./08-gcp-infrastructure.md#21-human-idpとagent-opの配置) |

## 監視

| ID | ルール | 出典 |
|---|---|---|
| RULE-38 | Raw Token、Secret、Private Keyをログへ保存しない | [09. §3](./09-security-monitoring.md#3-ログへ残さないもの) |
| RULE-39 | Raw Logをそのまま全部AIへ投入しない。Protocol Validation → Rule → Correlation → Risk Score → AI の順で処理する | [09. §1](./09-security-monitoring.md#1-基本方針) |
| RULE-40 | AgentごとのBaselineをAgent Definitionから構築する | [09. §5.4](./09-security-monitoring.md#54-agent-baseline) |
| RULE-41 | 異常なAgentをAgent Identity Domain単位でQuarantine / Revoke / Destroyできるようにする | [09. §6](./09-security-monitoring.md#6-response) |
| RULE-42 | Platform側のService AccountにSecurity Logの削除権限を与えない | [09. §4](./09-security-monitoring.md#4-正規化と保存) |

## アクティビティタイムライン

| ID | ルール | 出典 |
|---|---|---|
| RULE-54 | Activity Monitoring UIは人間向けの可視化だけを行い、認可判断や検知判断は行わない。表示するのはPolicy Engine、Tool Executor、Security Detectionがすでに下した決定である | [11. §2](./11-activity-timeline.md#2-基本方針) |
| RULE-55 | Activity Eventは、Security Detectionが収集する詳細ログ（09）とは別系統のPub/Subトピックとする。発行元のアプリが人間向けの説明文をイベント生成時に埋め込む | [11. §3](./11-activity-timeline.md#3-activity-event)、[11. §4](./11-activity-timeline.md#4-配信経路) |
| RULE-56 | Activity Feedの参照範囲はAccess Tokenの`sub`と一致する`human_subject`のイベントに限る。他ユーザーのログイン操作やAgentは表示しない | [11. §2](./11-activity-timeline.md#2-基本方針)、[11. §7](./11-activity-timeline.md#7-アクセス制御) |
| RULE-57 | ブラウザはFirestoreへ直接アクセスしない。Activity EventはAutomation Appの認証済みセッションを介してのみ配信する | [11. §4](./11-activity-timeline.md#4-配信経路)、[11. §7](./11-activity-timeline.md#7-アクセス制御) |
| RULE-58 | デモ用に台本化したActivity Eventには`is_simulated`を付与し、実イベントと視覚的に区別する。台本の再生は操作者自身のセッション範囲に閉じる | [11. §6.2](./11-activity-timeline.md#62-台本で補う)、[11. §7](./11-activity-timeline.md#7-アクセス制御) |
