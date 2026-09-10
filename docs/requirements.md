# 要件索引

この表は要件 ID とそれを扱うタスクの対応だけを持つ。
要件の本文は各 docs にあり、ここでは繰り返さない。
判断の根拠は `tasks/00-decisions.md`、逸脱は `deviations.md` が正本である。

`状態` は2値しかない。担当タスクがあるものが `planned`、後続フェーズへ送ったものが `deferred` で、
`deferred` の行は担当タスクID列を `-` にし、送り先を表題の末尾へ `（deferred: P6）` の形で付ける。

| REQ-ID | 表題 | 出典 | 担当タスクID | 状態 |
|---|---|---|---|---|
| REQ-01-001 | WorkSignalSource インタフェースと Document RS 実装を作る | [01.](./01-overview.md) | T-APP-04 | planned |
| REQ-01-002 | 監査ログの主語3フィールドを強制する | [01.](./01-overview.md) | T-SEC-04 | planned |
| REQ-01-003 | AgentStage 列挙と phase / owner の対応表を定義する | [01.](./01-overview.md) | T-APP-03 | planned |
| REQ-01-004 | Agent Identity と Human Identity の名前空間分離を強制する | [01.](./01-overview.md) | T-OP-18 | planned |
| REQ-01-005 | Effective Capability ⊆ Human Permission を再検証する | [01.](./01-overview.md) | T-PROV-12 | planned |
| REQ-01-006 | 権限ドメインの Firestore コレクションとスキーマを定義する | [01.](./01-overview.md) | T-AUTHZ-02 | planned |
| REQ-01-007 | AI 提案と Policy 決定を別レコードとして保存する | [01.](./01-overview.md) | T-AUTHZ-04 | planned |
| REQ-01-008 | Runtime のエントリポイントと起動パラメータ契約を実装する | [01.](./01-overview.md) | T-RUN-01 / T-RUN-10 | planned |
| REQ-01-009 | 常設サービス台帳と Control Plane 系 Cloud Run Service を定義する | [01.](./01-overview.md) | T-IAC-08 | planned |
| REQ-01-010 | 実行時作成の受け皿を Terraform に用意する | [01.](./01-overview.md) | T-IAC-13 / T-IAC-43 | planned |
| REQ-01-011 | Dedicated OP 一式を実行時に作成する | [01.](./01-overview.md) | T-PROV-24 / T-PROV-26 | planned |
| REQ-01-012 | Cloud SQL 不採用を構成で固定し Firestore の許可マトリクスを出力する | [01.](./01-overview.md) | T-IAC-25 | planned |
| REQ-01-013 | Tool / Connector Catalog のスキーマと型を定義する | [01.](./01-overview.md) | T-PROV-01 / T-PROV-02 / T-PROV-03 | planned |
| REQ-01-014 | Vertex AI 共通クライアントパッケージを実装する | [01.](./01-overview.md) | T-APP-02 | planned |
| REQ-01-015 | Resource 宛の Authorization ヘッダ生成を1関数へ集約する | [01.](./01-overview.md) | T-RUN-15 | planned |
| REQ-01-016 | 3種類の Identity 検証関数を種別ごとに分離する | [01.](./01-overview.md) | T-OP-08 / T-PKG-07 / T-PKG-27 | planned |
| REQ-01-017 | Resource API 共通の保護ミドルウェアを作る | [01.](./01-overview.md) | T-RES-11 / T-RES-12 | planned |
| REQ-01-018 | Finance の isolation_level 検証を実装する | [01.](./01-overview.md) | T-RES-19 / T-RES-21 | planned |
| REQ-01-019 | 権限ドメインの Firestore コレクションとスキーマを定義する | [01.](./01-overview.md) | T-AUTHZ-02 | planned |
| REQ-01-020 | Agent Identity Domain を破棄単位の1レコードとして定義する | [01.](./01-overview.md) | T-LIFE-03 | planned |
| REQ-01-021 | 用語辞書 docs/glossary.md を作る | [01.](./01-overview.md) | T-DOCS-09 / T-DOCS-10 | planned |
| REQ-01-022 | run.invoker のエッジを1つの locals に集約して生成する | [01.](./01-overview.md) | T-IAC-15 / T-IAC-42 | planned |
| REQ-01-023 | Native XAA 経路4ステップの E2E を通す | [01.](./01-overview.md) | T-RUN-27 | planned |
| REQ-01-024 | stub-saas-op と stub-saas-api を実装する | [01.](./01-overview.md) | T-BRIDGE-19 / T-BRIDGE-20 | planned |
| REQ-01-025 | Log Sink と BigQuery 監査テーブルを Terraform で定義する | [01.](./01-overview.md) | T-SEC-07 / T-SEC-08 | planned |
| REQ-01-026 | 構成図を単一プロジェクト構成へ更新して再生成する | [01.](./01-overview.md) | T-DOCS-11 | planned |
| REQ-01-027 | Cleanup step1 と step2（Job Execution 停止と ID-JAG 発行停止）を実装する | [01.](./01-overview.md) | T-LIFE-05 | planned |
| REQ-01-028 | Refresh Token の rotation と Revoke 経路を実装する | [01.](./01-overview.md) | T-OP-28 | planned |
| REQ-02-001 | 日報作成機能を実装する | [02.](./02-automation-design.md) | T-APP-05 | planned |
| REQ-02-002 | 自動化候補の提案 API を実装する | [02.](./02-automation-design.md) | T-APP-06 | planned |
| REQ-02-003 | Work Definition のデータモデルと DRAFT / CONFIRMED 遷移を実装する | [02.](./02-automation-design.md) | T-APP-07 | planned |
| REQ-02-004 | 承認レコードと Capability ハッシュ照合を実装する | [02.](./02-automation-design.md) | T-APP-10 | planned |
| REQ-02-005 | Work Definition のデータモデルと DRAFT / CONFIRMED 遷移を実装する | [02.](./02-automation-design.md) | T-APP-07 | planned |
| REQ-02-006 | 権限とResourceとIsolationの語彙を持ち込まない検査を作る | [02.](./02-automation-design.md) | T-APP-11 | planned |
| REQ-02-007 | requested_lifetime_minutes の範囲検証と UI 初期値を実装する | [02.](./02-automation-design.md) | T-APP-08 | planned |
| REQ-02-008 | Business Work Request の送信を実装する | [02.](./02-automation-design.md) | T-APP-09 | planned |
| REQ-02-009 | Business Work Request の受信側スキーマ検証を実装する | [02.](./02-automation-design.md) | T-AUTHZ-09 | planned |
| REQ-02-010 | human_subject 照合ミドルウェアを実装する | [02.](./02-automation-design.md) | T-AUTHZ-07 | planned |
| REQ-02-011 | scope から audience を決める対応表を実装する | [02.](./02-automation-design.md) | T-IDP-11 | planned |
| REQ-02-012 | Access Token 基本検証ミドルウェアを実装する | [02.](./02-automation-design.md) | T-AUTHZ-05 | planned |
| REQ-02-013 | 操作 scope を登録して未登録 scope を拒否する | [02.](./02-automation-design.md) | T-IDP-09 / T-IDP-12 | planned |
| REQ-02-014 | DPoP 束縛 Access Token を発行する | [02.](./02-automation-design.md) | T-IDP-18 | planned |
| REQ-02-015 | 8ステップ検証を1本のミドルウェアへ結線する | [02.](./02-automation-design.md) | T-AUTHZ-08 | planned |
| REQ-02-016 | Agent Definition のスキーマ検証を実装する | [02.](./02-automation-design.md) | T-PROV-10 | planned |
| REQ-02-017 | decision_id から Effective Capability と Isolation Level を再取得して照合する | [02.](./02-automation-design.md) | T-PROV-11 | planned |
| REQ-02-018 | Finance のデータモデルと Firestore コレクションを作る | [02.](./02-automation-design.md) | T-RES-16 / T-RES-17 / T-RES-18 / T-RES-20 | planned |
| REQ-02-019 | Document のデータモデルと Firestore コレクションを作る | [02.](./02-automation-design.md) | T-RES-13 / T-RES-14 / T-RES-15 | planned |
| REQ-02-020 | FULL_ISOLATION の同時実行数の上限で 503 を返す | [02.](./02-automation-design.md) | T-PROV-25 | planned |
| REQ-02-021 | 実行中 Agent の状況確認 API を実装する | [02.](./02-automation-design.md) | T-APP-13 | planned |
| REQ-02-022 | Agent 操作系の human_subject 一致認可を実装する | [02.](./02-automation-design.md) | T-APP-12 | planned |
| REQ-02-023 | Agent 停止操作を Lifecycle Manager へ委譲する | [02.](./02-automation-design.md) | T-APP-14 | planned |
| REQ-02-024 | 追加指示の書き込みと適用状態を実装する | [02.](./02-automation-design.md) | T-APP-15 | planned |
| REQ-02-025 | 追加指示の読み取りと `applied_at` 更新を同一トランザクションで実装する | [02.](./02-automation-design.md) | T-RUN-22 | planned |
| REQ-02-026 | Allowed Tools 判定（step2）と `tool_not_allowed` の返却を実装する | [02.](./02-automation-design.md) | T-RUN-07 | planned |
| REQ-02-027 | 権限拡大時に新規 Agent 作成へ誘導する画面を実装する | [02.](./02-automation-design.md) | T-APP-16 | planned |
| REQ-02-028 | Agent 操作3種の監査ログを実装する | [02.](./02-automation-design.md) | T-APP-17 | planned |
| REQ-02-029 | Automation App の Activity Event 4種を発行する | [02.](./02-automation-design.md) | T-APP-22 | planned |
| REQ-02-030 | 状況確認とタイムラインの導線を分離する | [02.](./02-automation-design.md) | T-APP-18 | planned |
| REQ-02-031 | docs 02 の例示シナリオを検証用リソースサーバー2種へ書き換える | [02.](./02-automation-design.md) | T-DOCS-12 | planned |
| REQ-03-001 | 権限決定 API を実装する | [03.](./03-authorization.md) | T-AUTHZ-10 | planned |
| REQ-03-002 | Work Definition 構造化モジュールを実装する | [03.](./03-authorization.md) | T-AUTHZ-11 | planned |
| REQ-03-003 | Authorization Platform のアプリ骨格とルート表面を固定する | [03.](./03-authorization.md) | T-AUTHZ-01 | planned |
| REQ-03-004 | 定義データのコレクション構成と複合インデックスを定義する | [03.](./03-authorization.md) | T-IAC-24 | planned |
| REQ-03-005 | Authorization AI Agent を実装する | [03.](./03-authorization.md) | T-AUTHZ-12 | planned |
| REQ-03-006 | Proposed Capability を Taxonomy 内へ制限する | [03.](./03-authorization.md) | T-AUTHZ-14 | planned |
| REQ-03-007 | AI 出力ガード（技術値と決定の破棄）を実装する | [03.](./03-authorization.md) | T-AUTHZ-13 | planned |
| REQ-03-008 | AI 出力ガード（技術値と決定の破棄）を実装する | [03.](./03-authorization.md) | T-AUTHZ-13 | planned |
| REQ-03-009 | 定義データのコレクション構成と複合インデックスを定義する | [03.](./03-authorization.md) | T-IAC-24 | planned |
| REQ-03-010 | ポリシーデータの投入ジョブと Human Permission 変更 CLI を作る | [03.](./03-authorization.md) | T-AUTHZ-03 | planned |
| REQ-03-011 | Delegatable Permission の適用を実装する | [03.](./03-authorization.md) | T-AUTHZ-16 | planned |
| REQ-03-012 | Organization Policy の2型を実装する | [03.](./03-authorization.md) | T-AUTHZ-17 | planned |
| REQ-03-013 | Risk Policy の評価と risk_score 算出を実装する | [03.](./03-authorization.md) | T-AUTHZ-18 | planned |
| REQ-03-014 | Effective Capability の集合演算を純粋関数として実装する | [03.](./03-authorization.md) | T-AUTHZ-19 | planned |
| REQ-03-015 | Effective ⊆ Human の不変条件を強制する | [03.](./03-authorization.md) | T-AUTHZ-20 | planned |
| REQ-03-016 | Capability 単位の ALLOW / DENY と理由を永続化する | [03.](./03-authorization.md) | T-AUTHZ-22 | planned |
| REQ-03-017 | Security Profile の出力形式と決定規則を実装する | [03.](./03-authorization.md) | T-AUTHZ-21 | planned |
| REQ-03-018 | characteristics 7項目の固定とマージ規則を実装する | [03.](./03-authorization.md) | T-AUTHZ-15 | planned |
| REQ-03-019 | （担当タスク未割り当て）（deferred: P6） | [03.](./03-authorization.md) | - | deferred |
| REQ-03-020 | Cloud SQL 不採用を構成で固定し Firestore の許可マトリクスを出力する | [03.](./03-authorization.md) | T-IAC-25 | planned |
| REQ-03-021 | 権限決定フローを結線し Policy Engine へ4入力を同時に渡す | [03.](./03-authorization.md) | T-AUTHZ-23 | planned |
| REQ-03-022 | Human Permission 変更イベントを受けて Policy Engine のみで再評価する | [03.](./03-authorization.md) | T-AUTHZ-27 | planned |
| REQ-03-023 | Calendar と Mail のケースを回帰テストとして固定する | [03.](./03-authorization.md) | T-AUTHZ-29 | planned |
| REQ-03-024 | Finance ケース（FULL_ISOLATION）を回帰テストとして固定する | [03.](./03-authorization.md) | T-AUTHZ-30 | planned |
| REQ-04-001 | 定義データのコレクション構成と複合インデックスを定義する | [04.](./04-tool-catalog.md) | T-IAC-24 | planned |
| REQ-04-002 | Catalog と定義データを投入する seed Job を作る | [04.](./04-tool-catalog.md) | T-IAC-26 | planned |
| REQ-04-003 | Catalog と定義データを投入する seed Job を作る | [04.](./04-tool-catalog.md) | T-IAC-26 | planned |
| REQ-04-004 | seed 入力の構造検証を実装する | [04.](./04-tool-catalog.md) | T-IAC-27 | planned |
| REQ-04-005 | Bridge 経路の step5 と外部 SaaS の直接呼び出しを実装する | [04.](./04-tool-catalog.md) | T-RUN-14 | planned |
| REQ-04-006 | Native XAA で Bridge へフォールバックしない経路を固定する | [04.](./04-tool-catalog.md) | T-RUN-13 | planned |
| REQ-04-007 | Catalog と定義データを投入する seed Job を作る | [04.](./04-tool-catalog.md) | T-IAC-26 | planned |
| REQ-04-008 | Catalog と定義データを投入する seed Job を作る | [04.](./04-tool-catalog.md) | T-IAC-26 | planned |
| REQ-04-009 | seed 入力の構造検証を実装する | [04.](./04-tool-catalog.md) | T-IAC-27 | planned |
| REQ-04-010 | seed 入力の構造検証を実装する | [04.](./04-tool-catalog.md) | T-IAC-27 | planned |
| REQ-04-011 | Effective Capability から Allowed Tools を解決する | [04.](./04-tool-catalog.md) | T-PROV-04 | planned |
| REQ-04-012 | XAA 静的設定（audience / resource / scope）を生成する | [04.](./04-tool-catalog.md) | T-PROV-05 | planned |
| REQ-04-013 | Tool Manifest を生成する | [04.](./04-tool-catalog.md) | T-PROV-06 | planned |
| REQ-04-014 | Agent Registration へ書くキーを限定する | [04.](./04-tool-catalog.md) | T-PROV-07 | planned |
| REQ-04-015 | 動的な Tool と XAA 解決の不在を構成で固定する | [04.](./04-tool-catalog.md) | T-RUN-21 | planned |
| REQ-04-016 | Runtime のエントリポイントと起動パラメータ契約を実装する | [04.](./04-tool-catalog.md) | T-RUN-01 | planned |
| REQ-04-017 | LLM 出力の切り詰めと Manifest 優先の値解決を実装する | [04.](./04-tool-catalog.md) | T-RUN-19 | planned |
| REQ-04-018 | Tool Manifest のスキーマとロード（step1）を実装する | [04.](./04-tool-catalog.md) | T-RUN-06 / T-RUN-07 | planned |
| REQ-04-019 | Agent Expiration 判定（step3）を実装する | [04.](./04-tool-catalog.md) | T-RUN-08 | planned |
| REQ-04-020 | step4 の Token Exchange 要求を Manifest だけから組み立てる | [04.](./04-tool-catalog.md) | T-RUN-11 | planned |
| REQ-04-021 | step5 の Resource AS への ID-JAG 提示を実装する | [04.](./04-tool-catalog.md) | T-RUN-12 | planned |
| REQ-04-022 | step5.5 の constraint 検証を API 呼び出しの前に実装する | [04.](./04-tool-catalog.md) | T-RUN-16 / T-RUN-17 | planned |
| REQ-04-023 | step7 の response_schema による allowlist 射影を実装する | [04.](./04-tool-catalog.md) | T-RUN-18 | planned |
| REQ-04-024 | Agent Reasoning ループと Tool 宣言の生成を実装する | [04.](./04-tool-catalog.md) | T-RUN-20 | planned |
| REQ-04-025 | プロンプトインジェクション拒否を実証する | [04.](./04-tool-catalog.md) | T-RUN-29 | planned |
| REQ-04-026 | 権限外の追加指示を拒否し `rejected_instruction` を記録する | [04.](./04-tool-catalog.md) | T-RUN-23 | planned |
| REQ-04-027 | Catalog Repository を実装しエンドポイントの直書きを検査する | [04.](./04-tool-catalog.md) | T-PROV-03 | planned |
| REQ-04-028 | Tool 実行の段階構造化ログを実装する | [04.](./04-tool-catalog.md) | T-RUN-24 | planned |
| REQ-05-001 | Human IdP を CLI から生成してリポジトリへ取り込む | [05.](./05-identity.md) | T-IDP-01 / T-IDP-03 | planned |
| REQ-05-002 | クライアント `automation-app` を登録する | [05.](./05-identity.md) | T-IDP-06 | planned |
| REQ-05-003 | audience パラメータの許可リストを実装する | [05.](./05-identity.md) | T-IDP-10 / T-IDP-11 | planned |
| REQ-05-004 | 操作 scope を登録して未登録 scope を拒否する | [05.](./05-identity.md) | T-IDP-09 | planned |
| REQ-05-005 | XAA 用クライアント `agent-platform` を登録する | [05.](./05-identity.md) | T-IDP-07 | planned |
| REQ-05-006 | offline_access の同意判定フックを差し替える | [05.](./05-identity.md) | T-IDP-13 | planned |
| REQ-05-007 | Resource AS 2種を CLI 生成物として作成する | [05.](./05-identity.md) | T-RES-01 / T-RES-02 / T-RES-05 | planned |
| REQ-05-008 | Resource AS 2種を CLI 生成物として作成する | [05.](./05-identity.md) | T-RES-01 / T-RES-02 / T-RES-05 | planned |
| REQ-05-009 | 登録 scope の最小化と範囲外 scope の拒否を実装する | [05.](./05-identity.md) | T-RES-09 | planned |
| REQ-05-010 | Access Token 基本検証ミドルウェアを実装する | [05.](./05-identity.md) | T-AUTHZ-05 | planned |
| REQ-05-011 | Provisioner アプリの骨格と Human Access Token 検証を実装する | [05.](./05-identity.md) | T-PROV-08 | planned |
| REQ-05-012 | run.invoker のエッジを1つの locals に集約して生成する | [05.](./05-identity.md) | T-IAC-15 / T-IAC-40 | planned |
| REQ-05-013 | Automation App の骨格とセッションのトークン保管を実装する | [05.](./05-identity.md) | T-APP-01 | planned |
| REQ-05-014 | human_subject 照合ミドルウェアを実装する | [05.](./05-identity.md) | T-AUTHZ-07 | planned |
| REQ-05-015 | human_subject を Access Token の sub から確定する | [05.](./05-identity.md) | T-PROV-09 | planned |
| REQ-05-016 | Lifecycle Manager アプリの骨格と Access Token 8項目検証を実装する | [05.](./05-identity.md) | T-LIFE-01 | planned |
| REQ-05-017 | DPoP Proof の検証を固定順序で実装する | [05.](./05-identity.md) | T-PKG-10 | planned |
| REQ-05-018 | DPoP 束縛 Access Token を発行する | [05.](./05-identity.md) | T-IDP-18 | planned |
| REQ-05-019 | Access Token 基本検証ミドルウェアを実装する | [05.](./05-identity.md) | T-AUTHZ-05 | planned |
| REQ-05-020 | DPoP Proof 検証ミドルウェアを実装する | [05.](./05-identity.md) | T-AUTHZ-06 | planned |
| REQ-05-021 | DPoP Proof 検証ミドルウェアを実装する | [05.](./05-identity.md) | T-AUTHZ-06 | planned |
| REQ-05-022 | Control Plane 側8検証の Protocol Validation 送出を実装する | [05.](./05-identity.md) | T-SEC-12 | planned |
| REQ-05-023 | /token の応答形を固定し外部 SaaS への DPoP 強制を排除する | [05.](./05-identity.md) | T-BRIDGE-10 | planned |
| REQ-05-024 | ログインから Provisioning 完了までの e2e を1本にまとめる | [05.](./05-identity.md) | T-APP-37 | planned |
| REQ-05-025 | 共有 JWKS の取得とキャッシュを実装する | [05.](./05-identity.md) | T-OP-04 / T-PKG-08 | planned |
| REQ-05-026 | Agent OP の骨格と2モード起動を実装する | [05.](./05-identity.md) | T-OP-01 | planned |
| REQ-05-027 | 共有 JWKS バケットを作り書き込みを自分の鍵に限る | [05.](./05-identity.md) | T-IAC-20 / T-IAC-21 | planned |
| REQ-05-028 | discovery の jwks_uri と ID-JAG 宣言を上書きする | [05.](./05-identity.md) | T-IDP-05 | planned |
| REQ-05-029 | Firestore バックエンドのストアを実装して保持データを限定する | [05.](./05-identity.md) | T-IDP-04 / T-IDP-08 | planned |
| REQ-05-030 | /token で token-exchange を拒否する | [05.](./05-identity.md) | T-IDP-17 | planned |
| REQ-05-031 | 前提4点を使い捨て Terraform で実測する | [05.](./05-identity.md) | T-IAC-01 / T-IAC-09 | planned |
| REQ-05-032 | KMS Key Ring 5種と CryptoKey を shared state に作る | [05.](./05-identity.md) | T-IAC-18 | planned |
| REQ-05-033 | signIdJag を KMS 署名の唯一の入口として実装する | [05.](./05-identity.md) | T-OP-07 / T-PKG-06 / T-PKG-14 | planned |
| REQ-05-034 | ID-JAG 発行台帳と Resource AS 起点の突合バッチを実装する | [05.](./05-identity.md) | T-SEC-15 | planned |
| REQ-05-035 | Agent OP の永続データを4リポジトリに限定する | [05.](./05-identity.md) | T-OP-02 | planned |
| REQ-05-036 | Agent OP の責務境界を静的検査で固定する | [05.](./05-identity.md) | T-OP-03 | planned |
| REQ-05-037 | Agent OP の責務境界を静的検査で固定する | [05.](./05-identity.md) | T-OP-03 | planned |
| REQ-05-038 | Agent Registration の作成を実装する | [05.](./05-identity.md) | T-PROV-18 | planned |
| REQ-05-039 | Agent Registration の作成を実装する | [05.](./05-identity.md) | T-PROV-18 | planned |
| REQ-05-040 | Agent Registration へ書くキーを限定する | [05.](./05-identity.md) | T-PROV-07 | planned |
| REQ-05-041 | client_assertion_jwt ミドルウェアを実装する | [05.](./05-identity.md) | T-OP-09 | planned |
| REQ-05-042 | Agent Client Credential を生成し Execution へ渡す | [05.](./05-identity.md) | T-PROV-22 | planned |
| REQ-05-043 | Runtime のクレデンシャル保持境界を型と構成で強制する | [05.](./05-identity.md) | T-RUN-03 | planned |
| REQ-05-044 | actorTokenResolver を実装する | [05.](./05-identity.md) | T-OP-15 / T-PKG-18 | planned |
| REQ-05-045 | Human IdP Connection レコードと封筒暗号を実装する | [05.](./05-identity.md) | T-OP-24 | planned |
| REQ-05-046 | KMS Key Ring 5種と CryptoKey を shared state に作る | [05.](./05-identity.md) | T-IAC-18 | planned |
| REQ-05-047 | /xaa/callback と offline_access 認可の中断再開を実装する | [05.](./05-identity.md) | T-OP-25 | planned |
| REQ-05-048 | コールバックのリダイレクトでトークンを返さない | [05.](./05-identity.md) | T-OP-26 | planned |
| REQ-05-049 | Human IdP Connection の作成依頼を内部呼び出しで行う | [05.](./05-identity.md) | T-PROV-23 | planned |
| REQ-05-050 | Refresh Token Rotation と再利用検知を成立させる | [05.](./05-identity.md) | T-IDP-15 | planned |
| REQ-05-051 | /xaa/subject-token を実装する | [05.](./05-identity.md) | T-OP-27 | planned |
| REQ-05-052 | actor_token プロファイルと refresh_token subject の拒否を実装する | [05.](./05-identity.md) | T-OP-13 / T-PKG-17 / T-PKG-22 | planned |
| REQ-05-053 | Cleanup step3 として Human IdP Connection の Revoke と削除を実装する | [05.](./05-identity.md) | T-LIFE-06 | planned |
| REQ-05-054 | Automation App の骨格とセッションのトークン保管を実装する | [05.](./05-identity.md) | T-APP-01 | planned |
| REQ-05-055 | Agent Definition のスキーマ検証を実装する | [05.](./05-identity.md) | T-PROV-10 | planned |
| REQ-05-056 | 実行時作成の受け皿を Terraform に用意する | [05.](./05-identity.md) | T-IAC-13 / T-IAC-43 | planned |
| REQ-05-057 | Dedicated OP 一式を実行時に作成する | [05.](./05-identity.md) | T-PROV-24 / T-PROV-26 | planned |
| REQ-05-058 | Dedicated OP 一式に付ける IAM の雛形を定義する | [05.](./05-identity.md) | T-IAC-14 | planned |
| REQ-05-059 | Dedicated OP 一式に付ける IAM の雛形を定義する | [05.](./05-identity.md) | T-IAC-14 | planned |
| REQ-05-060 | Cloud Run Job Execution を1 Agent につき1つ起動する | [05.](./05-identity.md) | T-PROV-29 | planned |
| REQ-05-061 | Dedicated OP の署名鍵の解決と JWKS 掲載を実装する | [05.](./05-identity.md) | T-OP-06 | planned |
| REQ-05-062 | Blast Radius の3ケースを統合テストで固定する | [05.](./05-identity.md) | T-SEC-37 | planned |
| REQ-05-063 | Provisioning の11段順序とロールバックを実装する | [05.](./05-identity.md) | T-PROV-28 | planned |
| REQ-05-064 | step4 の Token Exchange 要求を Manifest だけから組み立てる | [05.](./05-identity.md) | T-RUN-11 | planned |
| REQ-05-065 | XAA 静的設定（audience / resource / scope）を生成する | [05.](./05-identity.md) | T-PROV-05 | planned |
| REQ-05-066 | actor_token と client_assertion の生成を分けて実装する | [05.](./05-identity.md) | T-RUN-09 | planned |
| REQ-05-067 | actor_token プロファイルと refresh_token subject の拒否を実装する | [05.](./05-identity.md) | T-OP-13 / T-PKG-18 / T-PKG-22 | planned |
| REQ-05-068 | subject_token の検証とエラー写像を実装する | [05.](./05-identity.md) | T-OP-14 / T-PKG-19 | planned |
| REQ-05-069 | actorTokenResolver を実装する | [05.](./05-identity.md) | T-OP-15 / T-PKG-06 | planned |
| REQ-05-070 | actor_token の exp と jti 再利用を検証する | [05.](./05-identity.md) | T-OP-16 / T-PKG-10 / T-PKG-11 | planned |
| REQ-05-071 | 委譲関係の照合ステップを実装する | [05.](./05-identity.md) | T-OP-17 | planned |
| REQ-05-072 | Agent の status と expires_at を要求ごとに判定する | [05.](./05-identity.md) | T-OP-19 | planned |
| REQ-05-073 | 静的 XAA 設定との照合を実装する | [05.](./05-identity.md) | T-OP-20 | planned |
| REQ-05-074 | /xaa/token の DPoP 検証ミドルウェアを実装する | [05.](./05-identity.md) | T-OP-10 / T-PKG-09 / T-PKG-10 / T-PKG-12 | planned |
| REQ-05-075 | Agent OP の10ステップ検証順序と送出を固定する | [05.](./05-identity.md) | T-SEC-13 | planned |
| REQ-05-076 | ID-JAG クレームを構築する | [05.](./05-identity.md) | T-OP-21 | planned |
| REQ-05-077 | cnf.jkt を付与し cnf 無しの発行経路を持たせない | [05.](./05-identity.md) | T-OP-22 / T-PKG-05 | planned |
| REQ-05-078 | ID-JAG の exp を Agent の expires_at で打ち切る | [05.](./05-identity.md) | T-OP-23 | planned |
| REQ-05-079 | cnf.jkt を付与し cnf 無しの発行経路を持たせない | [05.](./05-identity.md) | T-OP-22 / T-PKG-14 | planned |
| REQ-05-080 | クライアント登録を作らないことを固定する | [05.](./05-identity.md) | T-PROV-30 | planned |
| REQ-05-081 | 相関キーと Token fingerprint の生成関数を実装する | [05.](./05-identity.md) | T-SEC-03 / T-SEC-05 | planned |
| REQ-05-082 | Execution Context と DPoP 鍵のメモリ生成を実装する | [05.](./05-identity.md) | T-RUN-02 | planned |
| REQ-05-083 | step5 の Resource AS への ID-JAG 提示を実装する | [05.](./05-identity.md) | T-RUN-12 | planned |
| REQ-05-084 | Resource AS から ID-JAG 発行分岐と discovery の発行広告を削除する | [05.](./05-identity.md) | T-RES-03 / T-RES-06 / T-RES-23 | planned |
| REQ-05-085 | cnf.jkt と DPoP Proof の突き合わせをクライアント認証として実装する | [05.](./05-identity.md) | T-RES-07 / T-RES-23 | planned |
| REQ-05-086 | Resource AS の署名鍵を自己ブートストラップし JWKS へ公開する | [05.](./05-identity.md) | T-RES-04 / T-RES-08 / T-RES-23 | planned |
| REQ-05-087 | Resource API 共通の保護ミドルウェアを作る | [05.](./05-identity.md) | T-RES-11 / T-RES-17 / T-RES-23 | planned |
| REQ-05-088 | Resource API 共通の保護ミドルウェアを作る | [05.](./05-identity.md) | T-RES-11 / T-RES-14 / T-RES-23 | planned |
| REQ-05-089 | Native XAA で Bridge へフォールバックしない経路を固定する | [05.](./05-identity.md) | T-RUN-13 | planned |
| REQ-05-090 | Execution Context と DPoP 鍵のメモリ生成を実装する | [05.](./05-identity.md) | T-RUN-02 | planned |
| REQ-05-091 | Runtime のクレデンシャル保持境界を型と構成で強制する | [05.](./05-identity.md) | T-RUN-03 | planned |
| REQ-05-092 | Checkpoint のスキーマとサニタイザを実装する | [05.](./05-identity.md) | T-RUN-05 | planned |
| REQ-05-093 | Runtime Flow 10手順を Document と Finance で1本ずつ通す | [05.](./05-identity.md) | T-RUN-28 | planned |
| REQ-05-094 | Token 種類一覧と実装定数を突き合わせる | [05.](./05-identity.md) | T-DOCS-15 | planned |
| REQ-06-001 | Bridge の2面と stub SaaS OP を条件付きで定義する | [06.](./06-oauth-bridge.md) | T-IAC-11 | planned |
| REQ-06-002 | 経路ごとの呼び出し元 Service Account 認可ミドルウェアを実装する | [06.](./06-oauth-bridge.md) | T-BRIDGE-02 | planned |
| REQ-06-003 | /token の ID-JAG 検証を maronn の redeem 関数で実装する | [06.](./06-oauth-bridge.md) | T-BRIDGE-05 | planned |
| REQ-06-004 | cnf.jkt と DPoP Proof の照合を fail-closed で実装する | [06.](./06-oauth-bridge.md) | T-BRIDGE-06 | planned |
| REQ-06-005 | Agent Binding の解決と期限判定を実装する | [06.](./06-oauth-bridge.md) | T-BRIDGE-07 | planned |
| REQ-06-006 | scope の二重包含チェックを集合演算で実装する | [06.](./06-oauth-bridge.md) | T-BRIDGE-08 | planned |
| REQ-06-007 | SaaS の Refresh Token Grant を実行し Access Token を取得する | [06.](./06-oauth-bridge.md) | T-BRIDGE-09 | planned |
| REQ-06-008 | アウトバウンド許可リストを実装し業務 API の中継経路を持たせない | [06.](./06-oauth-bridge.md) | T-BRIDGE-11 | planned |
| REQ-06-009 | /token の応答形を固定し外部 SaaS への DPoP 強制を排除する | [06.](./06-oauth-bridge.md) | T-BRIDGE-10 | planned |
| REQ-06-010 | Connection と Agent Binding のスキーマと暗号文型を実装する | [06.](./06-oauth-bridge.md) | T-BRIDGE-04 | planned |
| REQ-06-011 | Connection と Agent Binding のスキーマと暗号文型を実装する | [06.](./06-oauth-bridge.md) | T-BRIDGE-04 / T-BRIDGE-18 | planned |
| REQ-06-012 | Check Connection API を実装し再 Consent を回避する | [06.](./06-oauth-bridge.md) | T-BRIDGE-13 | planned |
| REQ-06-013 | Consent 開始エンドポイントを実装する | [06.](./06-oauth-bridge.md) | T-BRIDGE-14 | planned |
| REQ-06-014 | OAuth Callback を処理し Connection を upsert する | [06.](./06-oauth-bridge.md) | T-BRIDGE-15 | planned |
| REQ-06-015 | リダイレクトにトークンを載せないことを共通関数で強制する | [06.](./06-oauth-bridge.md) | T-BRIDGE-16 | planned |
| REQ-06-016 | Verify Connection をサーバ間 API として実装する | [06.](./06-oauth-bridge.md) | T-BRIDGE-17 | planned |
| REQ-06-017 | Agent Binding の作成と無効化と削除の API を実装する | [06.](./06-oauth-bridge.md) | T-BRIDGE-18 | planned |
| REQ-06-018 | Check Connection API を実装し再 Consent を回避する | [06.](./06-oauth-bridge.md) | T-BRIDGE-13 / T-BRIDGE-20 | planned |
| REQ-06-019 | Secret Manager の Secret を作りアクセスを Bridge だけに限る | [06.](./06-oauth-bridge.md) | T-IAC-22 | planned |
| REQ-06-020 | Bridge の2面と stub SaaS OP を条件付きで定義する | [06.](./06-oauth-bridge.md) | T-IAC-11 | planned |
| REQ-06-021 | Connector Definition レジストリを設定駆動で実装する | [06.](./06-oauth-bridge.md) | T-BRIDGE-03 | planned |
| REQ-06-022 | Bridge 経路の E2E と既定 apply での非生成を検査する | [06.](./06-oauth-bridge.md) | T-BRIDGE-20 | planned |
| REQ-06-023 | Bridge アプリの骨格を作り、2面分割とルート集合を固定する | [06.](./06-oauth-bridge.md) | T-BRIDGE-01 | planned |
| REQ-07-001 | expires_at を算出して上限をクランプする | [07.](./07-lifecycle.md) | T-PROV-20 | planned |
| REQ-07-002 | Lifecycle 状態機械 transition() を実装する | [07.](./07-lifecycle.md) | T-LIFE-02 | planned |
| REQ-07-003 | Provisioning Transaction のスキーマと状態遷移を実装する | [07.](./07-lifecycle.md) | T-PROV-13 | planned |
| REQ-07-004 | one-time completion code を実装する | [07.](./07-lifecycle.md) | T-PROV-15 | planned |
| REQ-07-005 | 検証を Transaction 作成より前に置く順序を固定する | [07.](./07-lifecycle.md) | T-PROV-14 | planned |
| REQ-07-006 | XAA 静的設定（audience / resource / scope）を生成する | [07.](./07-lifecycle.md) | T-PROV-05 | planned |
| REQ-07-007 | Agent Client Credential を生成し Execution へ渡す | [07.](./07-lifecycle.md) | T-PROV-22 | planned |
| REQ-07-008 | 動的な Tool と XAA 解決の不在を構成で固定する | [07.](./07-lifecycle.md) | T-RUN-21 | planned |
| REQ-07-009 | Provisioning の11段順序とロールバックを実装する | [07.](./07-lifecycle.md) | T-PROV-28 | planned |
| REQ-07-010 | prompt=none による無操作の再認可を成立させる | [07.](./07-lifecycle.md) | T-IDP-14 | planned |
| REQ-07-011 | CONSENT_REQUIRED 中断応答を固定する | [07.](./07-lifecycle.md) | T-PROV-16 | planned |
| REQ-07-012 | Resume Transaction API を実装する | [07.](./07-lifecycle.md) | T-PROV-17 | planned |
| REQ-07-013 | STANDARD 分岐で GCP リソースを作らないことを固定する | [07.](./07-lifecycle.md) | T-PROV-27 | planned |
| REQ-07-014 | Dedicated OP 一式を実行時に作成する | [07.](./07-lifecycle.md) | T-PROV-24 | planned |
| REQ-07-015 | Cloud Run Job Execution を1 Agent につき1つ起動する | [07.](./07-lifecycle.md) | T-PROV-29 | planned |
| REQ-07-016 | Agent の status と expires_at を要求ごとに判定する | [07.](./07-lifecycle.md) | T-OP-19 | planned |
| REQ-07-017 | ID-JAG の exp を Agent の expires_at で打ち切る | [07.](./07-lifecycle.md) | T-OP-23 | planned |
| REQ-07-018 | Registration と IdP Connection と Agent Binding の expires_at を一致させる | [07.](./07-lifecycle.md) | T-PROV-21 | planned |
| REQ-07-019 | Checkpoint のスキーマとサニタイザを実装する | [07.](./07-lifecycle.md) | T-RUN-05 | planned |
| REQ-07-020 | cleanupAgent の11ステップ枠組みと冪等性を実装する | [07.](./07-lifecycle.md) | T-LIFE-04 / T-LIFE-08 | planned |
| REQ-07-021 | Cleanup step4 と step5（Binding 無効化と発行済み Credential の Revoke）を実装する | [07.](./07-lifecycle.md) | T-LIFE-07 / T-RES-22 | planned |
| REQ-07-022 | Revoke を Refresh Token 単位に限定する | [07.](./07-lifecycle.md) | T-IDP-16 | planned |
| REQ-07-023 | Cleanup step8 と step9 で Dedicated OP 一式を削除する | [07.](./07-lifecycle.md) | T-LIFE-09 | planned |
| REQ-07-024 | 定期 sweep と EXPIRING / EXPIRED 判定を実装する | [07.](./07-lifecycle.md) | T-LIFE-10 | planned |
| REQ-07-025 | ユーザーによる Agent 停止 API を実装する | [07.](./07-lifecycle.md) | T-LIFE-11 | planned |
| REQ-07-026 | SUSPICIOUS と QUARANTINED の遷移 API を実装する | [07.](./07-lifecycle.md) | T-LIFE-12 | planned |
| REQ-07-027 | Human Permission 変更イベントを受けて Policy Engine のみで再評価する | [07.](./07-lifecycle.md) | T-AUTHZ-27 | planned |
| REQ-07-028 | 再評価結果ごとの分岐を実装する | [07.](./07-lifecycle.md) | T-AUTHZ-28 | planned |
| REQ-07-029 | reprovision() を実装する | [07.](./07-lifecycle.md) | T-LIFE-13 | planned |
| REQ-07-030 | Re-Provisioning 不能時の中止と通知を実装する | [07.](./07-lifecycle.md) | T-LIFE-14 | planned |
| REQ-07-031 | Lifecycle の Activity Event 3種と Re-Provisioning の監査ログを実装する | [07.](./07-lifecycle.md) | T-LIFE-16 | planned |
| REQ-07-032 | human-identity-disabled の購読と全 Agent 即時 Revoke を実装する | [07.](./07-lifecycle.md) | T-LIFE-15 | planned |
| REQ-07-033 | 権限外の追加指示を拒否し `rejected_instruction` を記録する | [07.](./07-lifecycle.md) | T-RUN-23 | planned |
| REQ-07-034 | Registration の更新経路を封じる | [07.](./07-lifecycle.md) | T-PROV-19 | planned |
| REQ-07-035 | Lifecycle の監査レコード用テーブルと追記権限を作る | [07.](./07-lifecycle.md) | T-IAC-32 | planned |
| REQ-07-036 | ログインから Provisioning 完了までの e2e を1本にまとめる | [07.](./07-lifecycle.md) | T-APP-37 | planned |
| REQ-07-037 | STANDARD 用 Agent Runtime Job と生存時間変数を定義する | [07.](./07-lifecycle.md) | T-IAC-12 | planned |
| REQ-07-038 | Provisioning の Activity Event を発行する | [07.](./07-lifecycle.md) | T-PROV-32 | planned |
| REQ-08-001 | 単一プロジェクトの変数定義と14 API の有効化を書く | [08.](./08-gcp-infrastructure.md) | T-IAC-04 | planned |
| REQ-08-002 | BigQuery 監査 dataset と Log Sink を shared state に作る | [08.](./08-gcp-infrastructure.md) | T-IAC-31 | planned |
| REQ-08-003 | forbidden-roles 検査スクリプトを作る | [08.](./08-gcp-infrastructure.md) | T-IAC-41 | planned |
| REQ-08-004 | Cloud Run Service の共通モジュールを作る | [08.](./08-gcp-infrastructure.md) | T-IAC-06 | planned |
| REQ-08-005 | 常設サービス台帳と Control Plane 系 Cloud Run Service を定義する | [08.](./08-gcp-infrastructure.md) | T-IAC-08 | planned |
| REQ-08-006 | STANDARD 用 Agent Runtime Job と生存時間変数を定義する | [08.](./08-gcp-infrastructure.md) | T-IAC-12 | planned |
| REQ-08-007 | 実行時作成の受け皿を Terraform に用意する | [08.](./08-gcp-infrastructure.md) | T-IAC-13 | planned |
| REQ-08-008 | Dedicated OP 一式を実行時に作成する | [08.](./08-gcp-infrastructure.md) | T-PROV-24 | planned |
| REQ-08-009 | Provisioner と Lifecycle の作成権限を名前空間で絞る | [08.](./08-gcp-infrastructure.md) | T-IAC-37 | planned |
| REQ-08-010 | Cleanup step8 と step9 で Dedicated OP 一式を削除する | [08.](./08-gcp-infrastructure.md) | T-LIFE-09 | planned |
| REQ-08-011 | Provisioner と Lifecycle の作成権限を名前空間で絞る | [08.](./08-gcp-infrastructure.md) | T-IAC-37 | planned |
| REQ-08-012 | issuer_profile を切り替え LB の予約リソースを既定で作らない | [08.](./08-gcp-infrastructure.md) | T-IAC-17 | planned |
| REQ-08-013 | issuer_profile を切り替え LB の予約リソースを既定で作らない | [08.](./08-gcp-infrastructure.md) | T-IAC-17 | planned |
| REQ-08-014 | Identity 系サービスを定義し /xaa/token を内部限定にする | [08.](./08-gcp-infrastructure.md) | T-IAC-09 | planned |
| REQ-08-015 | Agent OP の骨格と2モード起動を実装する | [08.](./08-gcp-infrastructure.md) | T-OP-01 | planned |
| REQ-08-016 | 共有 JWKS バケットを作り書き込みを自分の鍵に限る | [08.](./08-gcp-infrastructure.md) | T-IAC-20 | planned |
| REQ-08-017 | 自鍵の公開鍵を共有 JWKS へ書き込む | [08.](./08-gcp-infrastructure.md) | T-OP-05 | planned |
| REQ-08-018 | 署名鍵の自己ブートストラップと JWKS オブジェクト公開を実装する | [08.](./08-gcp-infrastructure.md) | T-IDP-03 / T-IDP-05 | planned |
| REQ-08-019 | Human IdP を CLI から生成してリポジトリへ取り込む | [08.](./08-gcp-infrastructure.md) | T-IDP-01 / T-IDP-02 | planned |
| REQ-08-020 | /xaa/token をステップ関数の固定順で組み立てる | [08.](./08-gcp-infrastructure.md) | T-OP-12 / T-PKG-22 | planned |
| REQ-08-021 | run.invoker のエッジを1つの locals に集約して生成する | [08.](./08-gcp-infrastructure.md) | T-IAC-15 / T-IAC-40 | planned |
| REQ-08-022 | Dedicated OP 一式に付ける IAM の雛形を定義する | [08.](./08-gcp-infrastructure.md) | T-IAC-14 / T-IAC-42 | planned |
| REQ-08-023 | human-permission-changed トピックと push subscription を作る | [08.](./08-gcp-infrastructure.md) | T-IAC-29 | planned |
| REQ-08-024 | agent-activity-stream トピックと push subscription を作る | [08.](./08-gcp-infrastructure.md) | T-IAC-28 | planned |
| REQ-08-025 | agent-activity-stream トピックと push subscription を作る | [08.](./08-gcp-infrastructure.md) | T-IAC-28 | planned |
| REQ-08-026 | Cloud Scheduler から Lifecycle Manager を定期起動する | [08.](./08-gcp-infrastructure.md) | T-IAC-33 | planned |
| REQ-08-027 | Cloud Logging から Security Detection への一方向経路を作る | [08.](./08-gcp-infrastructure.md) | T-IAC-30 | planned |
| REQ-08-028 | 共通構造化ログヘルパを実装する | [08.](./08-gcp-infrastructure.md) | T-SEC-01 / T-SEC-02 / T-SEC-05 / T-SEC-06 / T-SEC-10 | planned |
| REQ-08-029 | KMS Key Ring 5種と CryptoKey を shared state に作る | [08.](./08-gcp-infrastructure.md) | T-IAC-18 | planned |
| REQ-08-030 | KMS の権限を鍵単位で付与しプロジェクトレベルでは与えない | [08.](./08-gcp-infrastructure.md) | T-IAC-19 | planned |
| REQ-08-031 | signIdJag を KMS 署名の唯一の入口として実装する | [08.](./08-gcp-infrastructure.md) | T-OP-07 / T-PKG-13 / T-PKG-14 | planned |
| REQ-08-032 | signIdJag を KMS 署名の唯一の入口として実装する | [08.](./08-gcp-infrastructure.md) | T-OP-07 / T-PKG-02 / T-PKG-13 / T-PKG-15 | planned |
| REQ-08-033 | Agent Client Credential を生成し Execution へ渡す | [08.](./08-gcp-infrastructure.md) | T-PROV-22 | planned |
| REQ-08-034 | Secret Manager の Secret を作りアクセスを Bridge だけに限る | [08.](./08-gcp-infrastructure.md) | T-IAC-22 | planned |
| REQ-08-035 | Cloud SQL 不採用を構成で固定し Firestore の許可マトリクスを出力する | [08.](./08-gcp-infrastructure.md) | T-IAC-25 | planned |
| REQ-08-036 | Cloud SQL 不採用を構成で固定し Firestore の許可マトリクスを出力する | [08.](./08-gcp-infrastructure.md) | T-IAC-25 | planned |
| REQ-08-037 | Cloud SQL 不採用を構成で固定し Firestore の許可マトリクスを出力する | [08.](./08-gcp-infrastructure.md) | T-IAC-25 | planned |
| REQ-08-038 | Firestore データベースと activity の TTL を作る | [08.](./08-gcp-infrastructure.md) | T-IAC-23 / T-IAC-44 | planned |
| REQ-08-039 | Firestore パスガードを Runtime へ束ねる | [08.](./08-gcp-infrastructure.md) | T-RUN-04 | planned |
| REQ-08-040 | 秘密情報の非保存とフロントの SDK 混入を CI で検査する | [08.](./08-gcp-infrastructure.md) | T-IAC-44 | planned |
| REQ-08-041 | 前提4点を使い捨て Terraform で実測する | [08.](./08-gcp-infrastructure.md) | T-IAC-01 / T-IAC-16 | planned |
| REQ-08-042 | Runtime のエントリポイントと起動パラメータ契約を実装する | [08.](./08-gcp-infrastructure.md) | T-RUN-01 | planned |
| REQ-08-043 | 前提4点を使い捨て Terraform で実測する | [08.](./08-gcp-infrastructure.md) | T-IAC-01 / T-IAC-16 / T-IAC-43 | planned |
| REQ-08-044 | Resource AS の失敗応答の記述を訂正する | [08.](./08-gcp-infrastructure.md) | T-DOCS-17 / T-RES-06 / T-RES-11 / T-RES-19 / T-RES-23 | planned |
| REQ-08-045 | リソースサーバー2種の4サービスと識別子変数を定義する | [08.](./08-gcp-infrastructure.md) | T-IAC-10 | planned |
| REQ-08-046 | アプリごとの Service Account を作るモジュールと SA 台帳を書く | [08.](./08-gcp-infrastructure.md) | T-IAC-05 / T-IAC-35 | planned |
| REQ-08-047 | アプリごとの Service Account を作るモジュールと SA 台帳を書く | [08.](./08-gcp-infrastructure.md) | T-IAC-05 / T-IAC-36 | planned |
| REQ-08-048 | human_subject を Access Token の sub から確定する | [08.](./08-gcp-infrastructure.md) | T-PROV-09 | planned |
| REQ-08-049 | Vertex AI の利用 SA とモデル変数を定義する | [08.](./08-gcp-infrastructure.md) | T-IAC-39 | planned |
| REQ-08-050 | Artifact Registry とイメージ供給の経路を作る | [08.](./08-gcp-infrastructure.md) | T-IAC-34 | planned |
| REQ-08-051 | destroy で課金リソースが残らない状態を固定する | [08.](./08-gcp-infrastructure.md) | T-IAC-45 | planned |
| REQ-08-052 | Cloud Run Job Execution を1 Agent につき1つ起動する | [08.](./08-gcp-infrastructure.md) | T-PROV-29 | planned |
| REQ-08-053 | STANDARD 分岐で GCP リソースを作らないことを固定する | [08.](./08-gcp-infrastructure.md) | T-PROV-27 | planned |
| REQ-08-054 | Google Bridge の到達範囲を3リソースに限定する | [08.](./08-gcp-infrastructure.md) | T-IAC-38 | planned |
| REQ-09-001 | 検知パイプラインの6段を型で固定する | [09.](./09-security-monitoring.md) | T-SEC-17 | planned |
| REQ-09-002 | Raw Log を Security AI へ渡せない lint ルールを追加する | [09.](./09-security-monitoring.md) | T-SEC-18 | planned |
| REQ-09-003 | 共通構造化ログヘルパを実装する | [09.](./09-security-monitoring.md) | T-SEC-01 / T-SEC-16 | planned |
| REQ-09-004 | Human IdP の構造化ログを出力する | [09.](./09-security-monitoring.md) | T-IDP-19 | planned |
| REQ-09-005 | Authorization AI Agent のログを出力する | [09.](./09-security-monitoring.md) | T-AUTHZ-24 | planned |
| REQ-09-006 | Policy Engine のログを出力する | [09.](./09-security-monitoring.md) | T-AUTHZ-25 | planned |
| REQ-09-007 | Provisioning の構造化ログを出力する | [09.](./09-security-monitoring.md) | T-PROV-31 | planned |
| REQ-09-008 | Token Exchange のログ14項目を出力する | [09.](./09-security-monitoring.md) | T-OP-30 | planned |
| REQ-09-009 | Human IdP Connection のログ5項目を出力する | [09.](./09-security-monitoring.md) | T-OP-31 | planned |
| REQ-09-010 | Bridge のログ7項目と Protocol Validation イベントを出力する | [09.](./09-security-monitoring.md) | T-BRIDGE-12 | planned |
| REQ-09-011 | Resource AS の受領ログ12項目を出力する | [09.](./09-security-monitoring.md) | T-RES-10 | planned |
| REQ-09-012 | Resource API のアクセスログ7項目を出力する | [09.](./09-security-monitoring.md) | T-RES-12 / T-RES-21 | planned |
| REQ-09-013 | Tool 実行の段階構造化ログを実装する | [09.](./09-security-monitoring.md) | T-RUN-24 | planned |
| REQ-09-014 | Control Plane と Runtime 系5ログ源の出力項目を実装する | [09.](./09-security-monitoring.md) | T-SEC-06 / T-SEC-32 | planned |
| REQ-09-015 | 秘密情報の redaction フィルタを実装する | [09.](./09-security-monitoring.md) | T-SEC-02 / T-SEC-10 | planned |
| REQ-09-016 | 相関キーと Token fingerprint の生成関数を実装する | [09.](./09-security-monitoring.md) | T-SEC-03 | planned |
| REQ-09-017 | 正規化 Event Schema と10種の変換関数を実装する | [09.](./09-security-monitoring.md) | T-SEC-16 | planned |
| REQ-09-018 | BigQuery 監査 dataset と Log Sink を shared state に作る | [09.](./09-security-monitoring.md) | T-IAC-31 | planned |
| REQ-09-019 | forbidden-roles 検査スクリプトを作る | [09.](./09-security-monitoring.md) | T-IAC-41 | planned |
| REQ-09-020 | 保存済み SQL 4本を BigQuery View として定義する | [09.](./09-security-monitoring.md) | T-SEC-09 / T-SEC-11 / T-SEC-14 | planned |
| REQ-09-021 | 委譲関係の照合ステップを実装する | [09.](./09-security-monitoring.md) | T-OP-17 | planned |
| REQ-09-022 | ID-JAG 発行台帳を出力する | [09.](./09-security-monitoring.md) | T-OP-32 | planned |
| REQ-09-023 | 保存済み SQL 4本を BigQuery View として定義する | [09.](./09-security-monitoring.md) | T-SEC-09 / T-SEC-15 | planned |
| REQ-09-024 | 静的 XAA 設定との照合を実装する | [09.](./09-security-monitoring.md) | T-OP-20 | planned |
| REQ-09-025 | Refresh Token の再利用を検知する | [09.](./09-security-monitoring.md) | T-OP-29 | planned |
| REQ-09-026 | DPoP 関連3違反の Protocol Validation を実装する | [09.](./09-security-monitoring.md) | T-OP-11 / T-PKG-10 / T-PKG-11 / T-PKG-12 | planned |
| REQ-09-027 | human_subject 照合ミドルウェアを実装する | [09.](./09-security-monitoring.md) | T-AUTHZ-07 | planned |
| REQ-09-028 | Tool 系 Activity Event と `unauthorized_tool` の発行を実装する | [09.](./09-security-monitoring.md) | T-RUN-25 | planned |
| REQ-09-029 | Agent Binding の解決と期限判定を実装する | [09.](./09-security-monitoring.md) | T-BRIDGE-07 / T-BRIDGE-12 | planned |
| REQ-09-030 | Rule Hit の型と閾値ファイル、Token 分類を実装する | [09.](./09-security-monitoring.md) | T-SEC-19 | planned |
| REQ-09-031 | Rule-based Detection の Authorization 分類を実装する | [09.](./09-security-monitoring.md) | T-SEC-20 | planned |
| REQ-09-032 | Rule-based Detection の Tool 分類を実装する | [09.](./09-security-monitoring.md) | T-SEC-21 | planned |
| REQ-09-033 | Rule-based Detection の Lifetime 分類を実装する | [09.](./09-security-monitoring.md) | T-SEC-22 | planned |
| REQ-09-034 | 保存済み SQL 4本を BigQuery View として定義する | [09.](./09-security-monitoring.md) | T-SEC-09 / T-SEC-23 | planned |
| REQ-09-035 | Rule-based Detection の Authorization AI 分類を実装する | [09.](./09-security-monitoring.md) | T-SEC-24 | planned |
| REQ-09-036 | agent_id 単位の Correlation と Finding 生成を実装する | [09.](./09-security-monitoring.md) | T-SEC-27 | planned |
| REQ-09-037 | human_subject 単位と全体単位の Correlation を実装する | [09.](./09-security-monitoring.md) | T-SEC-28 | planned |
| REQ-09-038 | Agent OP の責務境界を静的検査で固定する | [09.](./09-security-monitoring.md) | T-OP-03 / T-PKG-27 | planned |
| REQ-09-039 | Agent Baseline を Provisioning 完了時に生成する | [09.](./09-security-monitoring.md) | T-SEC-25 | planned |
| REQ-09-040 | Baseline 逸脱の6条件を判定する | [09.](./09-security-monitoring.md) | T-SEC-26 | planned |
| REQ-09-041 | Risk Score を13要素から算出する | [09.](./09-security-monitoring.md) | T-SEC-29 | planned |
| REQ-09-042 | Risk Level への写像と LOW 分岐を実装する | [09.](./09-security-monitoring.md) | T-SEC-30 | planned |
| REQ-09-043 | 単発 CRITICAL の2要素を固定する | [09.](./09-security-monitoring.md) | T-SEC-31 | planned |
| REQ-09-044 | Risk Level への写像と LOW 分岐を実装する | [09.](./09-security-monitoring.md) | T-SEC-30 | planned |
| REQ-09-045 | Security AI の入力を要約構造体に固定する | [09.](./09-security-monitoring.md) | T-SEC-32 | planned |
| REQ-09-046 | Security AI の出力スキーマ4観点とフォールバックを実装する | [09.](./09-security-monitoring.md) | T-SEC-33 | planned |
| REQ-09-047 | Lifecycle 状態機械 transition() を実装する | [09.](./09-security-monitoring.md) | T-LIFE-02 | planned |
| REQ-09-048 | Agent の status と expires_at を要求ごとに判定する | [09.](./09-security-monitoring.md) | T-OP-19 | planned |
| REQ-09-049 | cleanupAgent の11ステップ枠組みと冪等性を実装する | [09.](./09-security-monitoring.md) | T-LIFE-04 | planned |
| REQ-09-050 | 判断が曖昧な Finding を Human Review へ回す | [09.](./09-security-monitoring.md) | T-SEC-35 | planned |
| REQ-10-001 | 設計ルールを docs/rules.json と生成スクリプトへ移す | [10.](./10-design-rules.md) | T-DOCS-04 / T-DOCS-05 | planned |
| REQ-10-002 | docs の相互参照リンクとアンカーを検査する | [10.](./10-design-rules.md) | T-DOCS-13 / T-DOCS-16 | planned |
| REQ-10-003 | RULE と実装とテストの対応表を作る | [10.](./10-design-rules.md) | T-DOCS-14 | planned |
| REQ-10-004 | 逸脱レジストリ docs/deviations.md を作る | [10.](./10-design-rules.md) | T-DOCS-02 / T-DOCS-03 | planned |
| REQ-10-005 | 登録 scope の最小化と範囲外 scope の拒否を実装する | [10.](./10-design-rules.md) | T-RES-09 | planned |
| REQ-10-006 | クライアント登録を作らないことを固定する | [10.](./10-design-rules.md) | T-PROV-30 | planned |
| REQ-10-007 | signIdJag を KMS 署名の唯一の入口として実装する | [10.](./10-design-rules.md) | T-OP-07 / T-PKG-14 | planned |
| REQ-10-008 | 確定判断に合わせて RULE 10件を改訂する | [10.](./10-design-rules.md) | T-DOCS-05 / T-DOCS-06 | planned |
| REQ-10-009 | 確定判断に合わせて RULE 10件を改訂する | [10.](./10-design-rules.md) | T-DOCS-05 / T-DOCS-07 | planned |
| REQ-10-010 | 共有 JWKS バケットを作り書き込みを自分の鍵に限る | [10.](./10-design-rules.md) | T-IAC-20 / T-IAC-21 | planned |
| REQ-11-001 | Activity Event スキーマを定義し検証する | [11.](./11-activity-timeline.md) | T-APP-19 | planned |
| REQ-11-002 | Activity Event の発行関数を共有パッケージへ実装する | [11.](./11-activity-timeline.md) | T-APP-21 | planned |
| REQ-11-003 | Activity Event スキーマを定義し検証する | [11.](./11-activity-timeline.md) | T-APP-19 | planned |
| REQ-11-004 | agent-activity-stream トピックと push subscription を作る | [11.](./11-activity-timeline.md) | T-IAC-28 | planned |
| REQ-11-005 | Activity Event の発行関数を共有パッケージへ実装する | [11.](./11-activity-timeline.md) | T-APP-21 | planned |
| REQ-11-006 | Activity Subscriber を実装し Firestore へ冪等に書き込む | [11.](./11-activity-timeline.md) | T-APP-23 | planned |
| REQ-11-007 | Activity Subscriber を実装し Firestore へ冪等に書き込む | [11.](./11-activity-timeline.md) | T-APP-23 | planned |
| REQ-11-008 | task_id の3種と終端イベント表を定義する | [11.](./11-activity-timeline.md) | T-APP-20 | planned |
| REQ-11-009 | タイムライン取得 API を実装する | [11.](./11-activity-timeline.md) | T-APP-24 | planned |
| REQ-11-010 | Task の終端イベントを判定して1件だけ発行する | [11.](./11-activity-timeline.md) | T-RUN-26 | planned |
| REQ-11-011 | タイムライン取得 API を実装する | [11.](./11-activity-timeline.md) | T-APP-24 | planned |
| REQ-11-012 | フロントエンドの禁止依存を検査する | [11.](./11-activity-timeline.md) | T-APP-33 | planned |
| REQ-11-013 | フロントエンドの禁止依存を検査する | [11.](./11-activity-timeline.md) | T-APP-33 | planned |
| REQ-11-014 | Automation App の Activity Event 4種を発行する | [11.](./11-activity-timeline.md) | T-APP-22 | planned |
| REQ-11-015 | Authorization Platform の Activity Event を発行する | [11.](./11-activity-timeline.md) | T-AUTHZ-26 | planned |
| REQ-11-016 | Provisioning の Activity Event を発行する | [11.](./11-activity-timeline.md) | T-PROV-32 | planned |
| REQ-11-017 | Tool 系 Activity Event と `unauthorized_tool` の発行を実装する | [11.](./11-activity-timeline.md) | T-RUN-25 | planned |
| REQ-11-018 | PROTOCOL_VIOLATION の Activity Event を発行する | [11.](./11-activity-timeline.md) | T-OP-33 | planned |
| REQ-11-019 | AGENT_QUARANTINED の Activity Event を発行する | [11.](./11-activity-timeline.md) | T-SEC-36 | planned |
| REQ-11-020 | Lifecycle の Activity Event 3種と Re-Provisioning の監査ログを実装する | [11.](./11-activity-timeline.md) | T-LIFE-16 | planned |
| REQ-11-021 | タイムライン一覧画面を実装する | [11.](./11-activity-timeline.md) | T-APP-26 | planned |
| REQ-11-022 | 再生図の固定8ノード SVG を実装する | [11.](./11-activity-timeline.md) | T-APP-29 | planned |
| REQ-11-023 | 再生の進行制御を実装する | [11.](./11-activity-timeline.md) | T-APP-30 | planned |
| REQ-11-024 | blocked のステップを宛先の手前で止める | [11.](./11-activity-timeline.md) | T-APP-31 | planned |
| REQ-11-025 | 再生の進行制御を実装する | [11.](./11-activity-timeline.md) | T-APP-30 | planned |
| REQ-11-026 | detail の折りたたみ表示を実装する | [11.](./11-activity-timeline.md) | T-APP-28 | planned |
| REQ-11-027 | outcome と phase による強調表示を実装する | [11.](./11-activity-timeline.md) | T-APP-27 | planned |
| REQ-11-028 | タイムライン一覧画面を実装する | [11.](./11-activity-timeline.md) | T-APP-26 | planned |
| REQ-11-029 | is_simulated の Task にラベルを常時表示する | [11.](./11-activity-timeline.md) | T-APP-32 | planned |
| REQ-11-030 | デモ D-1 を実操作の E2E として通す | [11.](./11-activity-timeline.md) | T-RUN-30 | planned |
| REQ-11-031 | Organization Policy 違反のデモ経路を実操作で通す | [11.](./11-activity-timeline.md) | T-AUTHZ-31 | planned |
| REQ-11-032 | 有効期限切れデモの Lifecycle 側経路を統合テストで固定する | [11.](./11-activity-timeline.md) | T-LIFE-17 | planned |
| REQ-11-033 | 権限縮小による作り直しのデモ経路を実操作で通す | [11.](./11-activity-timeline.md) | T-AUTHZ-32 | planned |
| REQ-11-034 | 台本イベント注入 API を実装する | [11.](./11-activity-timeline.md) | T-APP-35 | planned |
| REQ-11-035 | 台本イベント注入 API を実装する | [11.](./11-activity-timeline.md) | T-APP-35 | planned |
| REQ-11-036 | 他ユーザーへの注入不能を negative test で固定する | [11.](./11-activity-timeline.md) | T-APP-36 | planned |
| REQ-11-037 | デモ専用画面と UI 側の判断ロジックを排除する | [11.](./11-activity-timeline.md) | T-APP-34 | planned |
| REQ-11-038 | 横断閲覧と記録スイッチを作らないことを固定する | [11.](./11-activity-timeline.md) | T-APP-25 | planned |
| REQ-11-039 | デモ専用画面と UI 側の判断ロジックを排除する | [11.](./11-activity-timeline.md) | T-APP-34 | planned |
| REQ-11-040 | 横断閲覧と記録スイッチを作らないことを固定する | [11.](./11-activity-timeline.md) | T-APP-25 | planned |
| REQ-11-041 | Firestore データベースと activity の TTL を作る | [11.](./11-activity-timeline.md) | T-IAC-23 | planned |
| REQ-11-042 | Activity Record を定義し、発行元が人間向けの内訳を書けるようにする | [11.](./11-activity-timeline.md) | T-APP-19 | planned |
| REQ-11-043 | Tool 呼び出しごとに、要求と応答と実行前の検証を記録する | [11.](./11-activity-timeline.md) | T-RUN-25 | planned |
| REQ-11-044 | Agent 自身が書いた文章を記録し、そのまま表示する | [11.](./11-activity-timeline.md) | T-RUN-25 | planned |
| REQ-11-045 | Tool 呼び出しの経路を hop として記録し、再生で1本ずつ動かす | [11.](./11-activity-timeline.md) | T-APP-29 | planned |
| REQ-11-046 | 再生に再生・一時停止・次へ・最初からの操作を付ける | [11.](./11-activity-timeline.md) | T-APP-30 | planned |
| REQ-11-047 | 完了した Task の内訳をサーバー側で文章として描画する | [11.](./11-activity-timeline.md) | T-APP-26 | planned |
| REQ-11-048 | Agent 画面に、実行中でも読める実行ログを出す | [11.](./11-activity-timeline.md) | T-APP-24 | planned |
| REQ-11-049 | Agent の Execution が使う task_id を、再生の単位に合わせる | [11.](./11-activity-timeline.md) | T-APP-20 | planned |
