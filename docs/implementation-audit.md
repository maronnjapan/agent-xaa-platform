# `tasks/done` 実装監査

監査日は 2026-09-01 である。

対象はリポジトリ内の実装、テスト、Terraform、CI 定義であり、GCP への live apply は行っていない。

13 領域 374 タスクの「実装方針」と「完了条件」を、領域ごとに独立した監査で実装と照合した。挙げられた欠落は 161 件（critical 17 / high 42 / medium 54 / low 48）である。

## 結論

`tasks/done` の全要件が完了したとは判定できない。

ただし今回の監査で、**既定構成のまま deploy すると必ず失敗する経路**を洗い出し、そのうち production を止めるものを修正した。

修正後、`typecheck` / `lint` / `unit` / `e2e` / `infra/tests/static-all.sh` / `check:docs` はすべて通る。

`pnpm check:done` は依然として失敗する。未チェックの完了条件と、統合・改名で実在しなくなった成果物パスが残るためであり、これは実装の欠落そのものではない。

## 今回修正した欠落

### production 配線（コードは在ったが誰も呼んでいなかった）

| 項目 | 直したこと |
|---|---|
| Security Detection の検知パイプライン | `runOnce` が `void` されたまま production から到達不能だった。`createSecurityDetection()` で app と ingestion を同時に返し、`server.ts` で Pub/Sub の pull loop を起動し、Terraform が指す `POST /internal/security-events/push` を fail-closed で実装した |
| Lifecycle の `human-identity-disabled` 購読 | `handleIdentityDisabled` を呼ぶ経路が無かった。`subscribers/runner.ts` を足して起動時に購読し、topic と subscription を Terraform に追加した |
| Agent Runtime の invoker token | Cloud Run IAM 越しの Agent OP / Bridge 呼び出しに認証ヘッダが付いていなかった。内部宛にだけ `X-Serverless-Authorization` を付ける |
| Control Plane の Protocol Validation | 8 種の拒否を記録するエミッタをどのアプリも注入していなかった。共通エミッタを足し、authorization / provisioner / lifecycle で注入した |
| Bridge の Transaction 参照 | `readTransaction` が未注入で、Consent 開始が常に `invalid_transaction` だった |

### 経路とスキーマの食い違い（呼んでも必ず失敗していた）

| 項目 | 直したこと |
|---|---|
| Automation App → Provisioner | 実在しない `/api/provisioning` を呼び、body も受け口の閉じたスキーマと合っていなかった |
| Automation App → Lifecycle | 停止が `/api/agents/{id}/revoke` を呼んでいた。実ルートは `/agents/{id}/revoke` |
| 同意からの復帰 | Agent OP は `{automation}/provisioning/resume` へ 302 するが、その着地ルートが Automation App に無かった |
| one-time code | Agent OP は `bridge_consent_codes/{code}` へ書き、Provisioner は `provisioning_codes/{sha256}` を読んでいた。`@xaa/contracts` の正本に寄せた |
| Transaction の遷移 | callback が先に `RESUMABLE` へ動かすため、Provisioner の resume が遷移違反で 500 になっていた |
| Agent Definition | 承認レコードを作る production 経路が無く、承認と Provisioning へ到達できなかった |
| Access Token の制約 | AS は `xaa_constraints` で発行し、Resource Guard は `constraints` を読んでいた。token 由来の `max_amount` が一度も効いていなかった |
| Bridge 無効時の cleanup | `https://disabled.invalid` を実在の宛先として扱い、QUARANTINE と IDENTITY_DISABLED の cleanup が必ず失敗していた |
| Lifecycle の DPoP jti | production がインメモリで、インスタンスをまたぐ再送を拒否できなかった |

### 検知系の入力（記録はしていたが検知へ届いていなかった）

| 項目 | 直したこと |
|---|---|
| Agent OP と Human IdP のログ | 共有ロガーの封筒（`log_source` など）を持たない生の JSON を書いていた。Log Sink のフィルタは `jsonPayload.log_source != ""` であり、正規化もこの値で変換器を選ぶため、Token Exchange と ID-JAG 発行台帳と IdP Connection と IdP 監査の4種がどこにも届いていなかった |
| Agent Baseline | Provisioning 完了時に書かれていなかった。Baseline の無い Agent には Rule が1件も当たらないため、全 Rule 検知が無効だった |
| Lifecycle への遷移依頼 | URL・認証・body の3点が実装と食い違い、検知が隔離を決めても何も起きなかった |

### seed（Job が毎回失敗していた）

- `${resource:stub}` が resolver の 6 プレースホルダに無く、未解決で異常終了していた。
- `connector.schema.json` が入れ子形で、実 YAML（00b と `CatalogConnector` に一致する平坦形）を全件拒否していた。
- 実 YAML を解決して検証する回帰テストを足した。これが無かったため両方とも検出されていなかった。

### 検査とテストの回復

`pnpm lint`、`infra/tests/runtime-mutation-scope.sh`、`infra/tests/secret-iam.sh`、`infra/tests/dedicated-iam-shape.sh` と unit テスト 8 件が、前回の変更に追随できず失敗していた。

いずれも実装側の意図が正しいと判断し、検査とテストを実装へ合わせた。Dedicated OP のロールが 6 件になったのは、`/xaa/subject-token` が `agent-platform` の client secret を要する（DEC-ID-19）ためである。

## ゲートの現状

| コマンド | 結果 |
|---|---|
| `pnpm typecheck` | 成功 |
| `pnpm lint` | 成功 |
| `pnpm test:unit` | 成功（133 files、1,086 tests） |
| `pnpm test:e2e` | 成功（27 files、195 tests） |
| `bash infra/tests/static-all.sh` | 成功 |
| `pnpm check:docs` | 成功 |
| `pnpm test:integration` | 対象 0 件（`--passWithNoTests` で成功扱い） |
| `pnpm check:done` | 失敗 |

Node は 22 系が要る。`.node-version` が 22 を指し、`engines` が `>=22 <23` を要求する。

## 残る主な欠落

領域別監査で挙がった 112 件のうち、修正していないものの代表を挙げる。

| 優先度 | 領域 | 項目 |
|---|---|---|
| Critical | T-AUTHZ-27/28 | Human Permission 変更の再評価が未実装。受け口はあるが Policy Engine を回さず、Re-Provisioning 依頼は `human_subject` を `agent_id` の位置へ渡し、認証も付かない |
| Critical | T-RUN-25 | Tool 単位の Activity Event と `unauthorized_tool` の Protocol Validation が実行経路から発行されない |
| Critical | T-PKG-25 | Resource AS 2種と stub-saas-op の生成 OP がプロセスローカルのストアのまま（Human IdP は Firestore backend を持つ） |
| Critical | T-DOCS-05/08 | RULE 10件の改訂と docs 08 §7 の書き換えが未実施 |
| High | T-PROV-16 | Lifecycle が呼ぶ `POST /internal/provisioning/reprovision` が Provisioner に無い |
| High | T-PROV-28 | 11 段ステップとロールバックの orchestrator が production から呼ばれない |
| High | T-BRIDGE-03 | Bridge が読む `connector_definitions` を投入する経路が無い（`enable_google_bridge=true` のときだけ影響する） |
| High | T-SEC-15/20/22/23/24 | ID-JAG 発行台帳の突合バッチと、Authorization / Lifetime / Isolation / Authorization AI の Rule 分類が未実装 |
| High | T-SEC-26 | Baseline 逸脱判定 `detectDeviations` が検知パイプラインから呼ばれない |
| High | T-APP-18/26 | タイムライン画面と Agent 詳細画面を配信するルートが無い |
| High | T-APP-04/05/06 | WorkSignalSource が呼ばれず、日報と自動化候補が空入力で動く |
| High | T-AUTHZ-24/25 | Authorization AI と Policy Engine の判定ログが出ない |
| High | T-IAC-17 | `issuer_profile=loadbalancer` の実装が無い（既定の `direct` では影響しない） |
| Medium | T-PKG-25 | 生成 OP のストアがプロセスローカルのままの AS が 2 種ある（Human IdP は Firestore backend を持つ） |
| Medium | T-RES-19/21 | finance の isolation 検証が Terraform から有効化されず、承認監査ログの 4 項目が出ない |
| Medium | 全体 | `apps/*/test/integration/**` が 0 件で、Firestore emulator を使うサービス間配線が検証されていない |

`security-events` トピック名が 00b の `security-logs` と食い違っていた点は、トピックと subscription を 00b の名前へ揃えた。

`human-permission-changed` が push subscription である点は DEC-SEC-03（`agent-activity-stream` だけを push にする）と食い違うが、00b の HTTP 表は push を前提にしているため今回は変更していない。

## 監査の方法と限界

領域ごとに独立した監査を並列で走らせ、各タスクの実装方針と完了条件を実装へ突き合わせた。

判定は挙動で行い、成果物欄のパス不一致は欠落として扱っていない。実装時に多くのファイルが統合・改名されているためである。

live GCP でしか確認できない完了条件（`terraform apply` の成否、`gcloud` の出力）は、対応する定義がリポジトリに在るかだけを見た。

したがって本監査は「コードとして成立しているか」を示すものであり、「GCP 上で動くことを確認した」ものではない。
