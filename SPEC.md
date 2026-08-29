# 自律型AIエージェント × Cross App Access 認証認可基盤

GCP実行基盤を含む統合アーキテクチャ設計ドキュメントの目次である。
内容は `docs/` 配下の各文書にあり、本ファイルには要約と構成だけを置く。

## 要約

ユーザーがWeb画面上でAutomation Design AIと対話し、「何を自動化するか」をWork Definitionとして定義する。
Authorization Platform内のAuthorization AI AgentがWork DefinitionをVendor非依存の抽象Capabilityへ変換し、Policy EngineがHuman Permission、Delegatable Permission、Organization Policy、Risk Policyと照合してEffective CapabilityとIsolation Levelを確定する。
Tool / Connector CatalogでCapabilityを具体的なToolとXAA設定へ翻訳し、Agent専用のIdentity（Agent Registration、署名鍵、XAA静的設定）をProvisioningする。
AgentはCloud Run Jobとして最大24時間だけ存在し、Provisioning済みのToolだけを選んで、認証とAPI実行はDeterministic Tool Executorが行う。
Resourceへのアクセスは、Agent OPが発行するID-JAGをResource Authorization Serverへ提示するCross App Accessで行い、Googleなど非対応SaaSにはOAuth Bridgeを介する。
通常AgentはShared OPプロセスを共有してコストを抑え、高セキュリティAgentはDedicated OP、専用Service Account、専用鍵、専用Runtimeまで分離する。
期限到達、ユーザーによる停止、異常検知のいずれでもAgent Identity Domain全体を破棄し、Security Detectionが全レイヤーのログから異常を検知する。

## 文書構成

| No | 文書 | 内容 |
|---|---|---|
| 01 | [概要と用語](./docs/01-overview.md) | 目的、基本思想、アプリと機能の区別、3種類のIdentity、用語、全体像 |
| 02 | [自動化定義（Automation App）](./docs/02-automation-design.md) | ユーザー起因の自動化定義、Automation Design AIの責務、Business Work Request、Agent Definition、実行中Agentの操作 |
| 03 | [権限決定（Authorization Platform）](./docs/03-authorization.md) | 権限の種類、Work Definition構造化、Authorization AI Agent、抽象Capability、Policy Engine、Security Profile |
| 04 | [Tool / Connector CatalogとTool Executor](./docs/04-tool-catalog.md) | Catalogの内容、Resourceの2種類、Tool / Connector Definition、Provisioning時のTool解決、Tool Executor |
| 05 | [Identity](./docs/05-identity.md) | Human IdPとDPoP、Agent OP、Agent Registration、Isolation Model、Cross App Access、Tokenの種類 |
| 06 | [OAuth Bridge（Google Bridge）](./docs/06-oauth-bridge.md) | Bridgeの役割、Credential保持方針、Runtime Flow、Google Consent |
| 07 | [AgentのProvisioningとLifecycle](./docs/07-lifecycle.md) | Lifetime、Provisioning、Agent Runtime、Expiration / 緊急停止、権限変更時の扱い |
| 08 | [GCP実行基盤](./docs/08-gcp-infrastructure.md) | Project構成、デプロイ単位と内部機能、アプリ間の呼び出し関係、GCP Service Account、鍵と秘密情報、データストア、ネットワーク |
| 09 | [セキュリティ監視](./docs/09-security-monitoring.md) | ログ収集、正規化と保存、検知の段階、Risk Score、Security AI、Response |
| 10 | [設計ルール](./docs/10-design-rules.md) | 各文書で決めた原則の一覧 |

## 全体構成図

![全体構成図](./docs/diagrams/architecture.png)

| ファイル | 用途 |
|---|---|
| [architecture.png](./docs/diagrams/architecture.png) | Markdown表示用の画像 |
| [architecture.svg](./docs/diagrams/architecture.svg) | 拡大しても劣化しないベクター版 |
| [architecture.drawio](./docs/diagrams/architecture.drawio) | draw.ioで編集する場合の元データ |
| [generate.py](./docs/diagrams/generate.py) | 上記3ファイルの生成スクリプト |

図を変更するときは `generate.py` のレイアウト定義を編集し、`python3 docs/diagrams/generate.py` で3ファイルをまとめて再生成する。
draw.ioで直接編集した場合は、PNGとSVGが古いままになる点に注意する。

## 変更履歴

- 2026-08-30：単一ファイルだった設計メモを内容ごとに `docs/01`〜`10` へ分割し、レビュー指摘（`.review/SPEC.md.review.json`）を反映した。
