# タスク一覧

[docs](../docs/README.md) の設計を実装するためのタスクを、領域ごとに分けて置く。
docs 01 から 11 までの記述から実装可能な要件を421件抽出し、374件のタスクへ分解した。
要件はすべてどれかのタスクに紐づいており、取りこぼしは無い。

**13領域すべての実装が完了している。** 各領域のタスクファイルは
[done/](./done/) へ移してある。要件とタスクの対応は
[docs/requirements.md](../docs/requirements.md) が正本で、CI が実在を検査する。

完了条件の確認状況は `pnpm check:done` が検査する。
`- [x]` はリポジトリ内で確認した条件、`- [~]` は live の GCP でしか観測できない条件で、行内に観測するスクリプトを書く（[00b](./00b-conventions.md) 5節）。
成果物の宣言パスが統合や改名で無くなったものは [artifact-map.json](./artifact-map.json) が実体へ解決する。
`scripts/deploy-gcp-guide.sh` はこの検査が通らない間、GCP を変更する前に止まる。
突き合わせの結果は [docs/implementation-audit.md](../docs/implementation-audit.md) にある。

## 先に読むもの

| ファイル | 内容 |
|---|---|
| [00-decisions.md](./00-decisions.md) | 確定した設計判断。制約と docs が食い違う箇所をどう決めたか |
| [00b-conventions.md](./00b-conventions.md) | 識別子と成果物の所有者の確定表。タスク本文と食い違う場合はこちらが正しい |

## 制約と、それが設計に与えた影響

依頼時に与えられた制約は6つある。
優先順位は DEC-SCOPE-01 のとおり、IaC で管理できること、単一プロジェクト、低コスト、要件の完全達成の順とする。

| 制約 | 主な影響 | 判断 |
|---|---|---|
| GCP の設定を IaC で管理する（要件達成より優先） | 常設のリソースはすべて Terraform 管理。ただし FULL_ISOLATION の Dedicated OP 一式だけは例外とし、Provisioner が実行時に作り Lifecycle が消す。24時間で必ず消えるため IaC が保証する再現性の価値が無い | DEC-IAC-07 |
| GCP プロジェクトは1つ | 監査ログの分離を BigQuery dataset と Service Account と IAM で行う。同一プロジェクトの Owner には届くため保護は2プロジェクト構成より弱い | DEC-IAC-11 |
| 認証基盤は maronn-openid-connect を使う | Human IdP と Resource AS 2種は CLI 生成物、Agent OP だけは experimental のステップ関数を組み替えた自前ルート | DEC-ID-01 |
| リソースサーバーは金融とドキュメントの2種 | Document は STANDARD、Finance は FULL_ISOLATION 対象。どちらも Native XAA | 05-resource-servers.md |
| 検証用途。高コストを避ける | Load Balancer と Cloud SQL を既定構成から外す。放置しても月額約 $0.5、1日動かして $1.1 から $1.5 | DEC-COST-01 |
| 解釈の余地を作らない | 完了条件はコマンドかテスト名で判定する。識別子は 00b に1組だけ置く | DEC-TEST-04 |

## 実装フェーズ

前提フェーズが終わるまで次に着手しない。
各フェーズの完了条件は、実行できるコマンドか観測できる出力で書く。

### P0 前提の実測と足場

設計の前提4点を実測で確定させ、以降が手戻りしない土台を用意する。
作るものは spike 用の使い捨て Terraform、3 state の骨格とバージョン固定、pnpm workspace、`packages/xaa-crypto` と `packages/xaa-contracts`、静的検査と CI。

完了の目安は `infra/spike/RESULT.md` の4行が埋まり、`terraform -chdir=infra/envs/bootstrap apply` と shared の apply が成功して2回目の plan が no-op になり、CI 8ジョブが緑になること。

主なタスク：T-IAC-01 から T-IAC-07、T-PKG-01 から T-PKG-30、T-DOCS-01。

### P1 Identity 最小系

XAA の4ステップを、GCP に依存しない形で成立させる。
以降のすべてがここに依存する。

完了の目安は `pnpm test:e2e -- runtime/native-xaa-path` が緑になること。
内容は Human IdP のログインから ID Token を取り、`/xaa/token` で `cnf.jkt` と `act` を持つ ID-JAG を得て、Resource AS へ `jwt-bearer` と DPoP で提示し、`GET /documents` が 200 を返すまでである。

主なタスク：T-IDP、T-OP、T-RES-01 から T-RES-15、T-RUN-27。

### P2 Provisioning と Agent Runtime

Effective Capability を受け取って Agent を1体立ち上げ、Tool Executor 経由で Document を読んで書き戻すまでを通す。

完了の目安は Agent Definition の投入から Provisioning 11段階を完走し、`internal.document.list` で読み `internal.document.create` で書けること。
Allowed Tools 外の `tool_id` を Reasoning が返したとき、外部通信が0回で `tool_not_allowed` になること。

主なタスク：T-PROV、T-RUN-01 から T-RUN-26、T-RUN-29。

### P3 Lifecycle と FULL_ISOLATION

Agent を確実に消せる状態と、金融系リソースサーバー向けの隔離経路を作る。
検証環境の再現性はここで決まる。

完了の目安は Dedicated OP 一式を与えた Agent が Finance RS へ XAA を1本通し、`isolation_level` が `full_isolation` でない ID-JAG が 403 `insufficient_isolation` になること。
Cleanup を2回実行しても同じ結果になり、実行時に作った GCP リソースが1つも残らないこと。
`make demo-apply` と `make demo-destroy` を2周して2周目の plan が no-op になること。

主なタスク：T-LIFE、T-RES-16 から T-RES-23、T-IAC-13 から T-IAC-14。

### P4 権限決定

Business Work Request から Effective Capability と Security Profile を決定論的に導く。
Policy Engine は DB も LLM も時刻も参照しない純粋関数にする。

完了の目安は property テストで `Effective ⊆ Human` が常に成立すること。
`pnpm perm:set <subject> document.write revoke` の後に Re-Provisioning が走り、拡大は既存 Agent へ反映されないこと。

主なタスク：T-AUTHZ。

### P5 Automation App

人が触れる面を作る。
権限情報を持たず、決定を表示するだけという境界をコードとスキーマの両方で守る。

完了の目安は Playwright 1本で、ログインから Work Definition の確定、承認、Agent status が `ACTIVE` になり、タイムライン一覧に `provisioning` と `task-1` が並ぶまでが通ること。
他ユーザーの `agent_id` を指定した状況確認が 404 になること。

主なタスク：T-APP。

### P6 監査経路とデモと文書整合

起きたことが後から追える状態を作り、実操作デモを通し、docs と実装の食い違いを解消する。

完了の目安は BigQuery で検知 SQL 4本を実行して仕込んだ異常がそれぞれ1行ヒットすること。
実操作デモ4種の E2E が通ること。
CI の `docs:deviations` と `docs:traceability` と `docs:refs` が緑になること。

主なタスク：T-SEC、T-DOCS、T-RUN-30、T-BRIDGE（`enable_google_bridge=true` のときのみ）。

## 領域別のファイル

すべて完了済みで、`done/` にある。

| ファイル | 領域 | タスク数 | 主なフェーズ |
|---|---|---|---|
| [01-infra.md](./done/01-infra.md) | GCP 基盤（Terraform） | 47 | P0、P3 |
| [02-packages.md](./done/02-packages.md) | 共有パッケージとテスト基盤 | 30 | P0 |
| [03-human-idp.md](./done/03-human-idp.md) | Human IdP | 19 | P1 |
| [04-agent-op.md](./done/04-agent-op.md) | Agent OP（ID-JAG 発行） | 33 | P1 |
| [05-resource-servers.md](./done/05-resource-servers.md) | リソースサーバー2種 | 23 | P1、P3 |
| [06-provisioner.md](./done/06-provisioner.md) | Agent Provisioner と Tool Catalog | 32 | P2 |
| [07-authorization.md](./done/07-authorization.md) | Authorization Platform | 32 | P4 |
| [08-agent-runtime.md](./done/08-agent-runtime.md) | Agent Runtime と Tool Executor | 30 | P2 |
| [09-lifecycle.md](./done/09-lifecycle.md) | Lifecycle Manager | 17 | P3 |
| [10-automation-app.md](./done/10-automation-app.md) | Automation App とタイムライン | 37 | P5 |
| [11-security.md](./done/11-security.md) | セキュリティ監視 | 37 | P6 |
| [12-oauth-bridge.md](./done/12-oauth-bridge.md) | OAuth Bridge | 20 | P6（任意） |
| [13-docs-alignment.md](./done/13-docs-alignment.md) | 文書整合と逸脱管理 | 17 | P0、P6 |

## タスクの読み方

1タスクは6要素を持つ。

- **概要**：何を作るか、なぜ要るか。対応する設計判断
- **対象要件**：docs から抽出した要件 ID
- **前提タスク**：これが終わっていないと着手できないタスク
- **成果物**：作成または変更するファイルパス
- **実装方針**：関数名、型名、エンドポイント、環境変数、コレクション、エラーコード、検証の順序
- **完了条件**：コマンドかテスト名で判定できるチェックリスト

実装方針の値が 00b-conventions.md と食い違う場合は 00b が正しい。
完了条件が判定できないと感じたら、そのタスクは着手前に条件を書き直す。

## 要件 ID について

`REQ-01-001` の形の ID は docs から要件を抽出したときに採番したもので、docs の本文には存在しない。
全 ID の索引は [docs/requirements.md](../docs/requirements.md) にあり、`pnpm check:requirements` が
「planned の行が実在するタスク見出しを指しているか」を検査する。
