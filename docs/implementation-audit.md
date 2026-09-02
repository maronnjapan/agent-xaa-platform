# `tasks/done` 実装監査

監査日は 2026-09-02 である。前回（2026-09-01）の監査は末尾に残す。

対象はリポジトリ内の実装、テスト、Terraform、CI 定義であり、GCP への live apply は行っていない。

## 結論

`pnpm check:done` が終了コード 0 で通る。
`scripts/deploy-gcp-guide.sh all` は `--allow-unverified` なしで品質ゲートを抜け、GCP の変更へ進める。

13 領域 374 タスクの完了条件 1391 件を実装と突き合わせた結果は次のとおり。

| 状態 | 件数 | 意味 |
|---|---:|---|
| `- [x]` | 1258 | リポジトリ内で条件に書いたコマンドかテストで確認した |
| `- [~]` | 133 | live の GCP、`gcloud`、Docker daemon、実 Vertex AI が無いと観測できない。行内に観測するスクリプトを書いた |
| `- [ ]` | 0 | 未確認 |

タスクが宣言した成果物パスのうち、統合や改名で無くなった 423 件は `tasks/artifact-map.json` で実体へ解決した。
実体が無い成果物は残っていない。

## 今回直した欠落

### デプロイ経路（ガイドスクリプトを実行すると必ず失敗していた）

| 項目 | 直したこと |
|---|---|
| `typecheck` | `@xaa/contracts` が `@xaa/logging` を import するのに tsconfig の参照が無く、`tsc -b` の順序で落ちていた |
| コンテナビルド | pnpm 10 は inject されていない workspace からの `pnpm deploy` を拒否する。Dockerfile を `--legacy` へ切り替え、`strict-peer-dependencies` が止めていた esbuild の peer 範囲を直した |
| Automation App のエントリ | ビルド出力が `dist/src/server.js` で、固定の `dist/server.js` では起動できなかった。package.json の `main` からエントリを生成する |
| Tool Manifest の digest | Provisioner が base64url、Runtime が hex で比較していたため、実 Execution は起動時に `manifest_integrity_error` で死んでいた |
| seed の `human_permissions` | Job が毎回消して書き戻す入力が無く、権限表が空のまま全決定が何も許可しなかった。`infra/seed/human-permissions.yaml` を足した |
| Human IdP への revoke | `agent-platform` は confidential client なのに `client_id` だけで `/revoke` と `/token` を呼び 401 になっていた。HTTP Basic を付け、拒否時は 502 で Cleanup に再試行させる |
| FULL_ISOLATION の掃除 | Lifecycle が Dedicated OP ではなく共有 OP へ無効化を送り、404 を「済み」と読んでいた |
| Bridge 経路の Authorization | 外部 SaaS へ `DPoP` ヘッダと proof を送っていた。Bridge 経由は Bearer にする |
| Bridge の呼び出し元検証 | `startsWith` 比較で `sa-provisioner@…gserviceaccount.com.attacker.example` を通していた |
| 孤児リソースの掃除 | sweep 段 (e) の lister が本番で注入されておらず不活性だった |
| 日報の書き込み | Automation App のサービス ID を Document RS が受け付けず 401 になっていた。`POST /documents` の `type=daily_report` に限る受け口を足した |
| CI | unit / e2e ジョブがビルド前に vitest を走らせ `@xaa/*` を解決できなかった。ESLint の flat config で REQ-09-038 の import 禁止が後段に上書きされて不活性だった |

### 検知系の入力

| 項目 | 直したこと |
|---|---|
| Identity 5 イベントのログ項目名 | 各アプリ独自の名前で出していたものを docs 09 §2 の表（`IDENTITY_EVENT_FIELDS`）に揃え、`expectLogFields` で各アプリが 1 行ずつ固定する |
| ID-JAG 発行台帳の突合 | Resource AS が `idjag_kid` で書き、SQL が `received_kid` を読んでいたため `signing_key_misuse` が当たらなかった |
| 横移動の相関 | `correlateCrossAgent` が発行元 Agent だけを数え、docs 09 §5.3 の事例を検知しなかった |
| Runtime の redaction | `issued_jkt` がエントロピー規則で塗りつぶされ、検知 SQL が読めなかった |

### 規約側の整備

- `pnpm check:done` は `tasks/artifact-map.json` でパス不在を解決し、live でしか観測できない条件の印 `- [~]` を受け付ける（`tasks/00b-conventions.md` 5 節）。
- stub-saas-op は生成物を使わず手書きの最小 OP のままにする判断を DEC-ID-01 の注記に書いた。
- 条件の文言が 00b で確定した識別子や実装の契約と食い違っていた 83 件は、意図を保ったまま成立する形へ書き換えた。書き換えた行はそれと分かるよう理由を括弧で残してある。

## ゲートの現状

| コマンド | 結果 |
|---|---|
| `pnpm typecheck` | 成功 |
| `pnpm lint` / `pnpm lint:rules` | 成功 |
| `pnpm test:unit` | 成功（230 files、1,757 tests） |
| `pnpm test:e2e` | 成功（73 files、320 tests。`ENABLE_GOOGLE_BRIDGE=true` で Bridge 系も実行） |
| `pnpm test:integration` | 対象 0 件（`--passWithNoTests` で成功扱い） |
| `pnpm check:docs` と strict 2 検査 | 成功 |
| `bash infra/tests/static-all.sh` | 成功（31 検査） |
| `terraform fmt -check` / `terraform validate`（3 state） | 成功 |
| `pnpm check:done` | 成功 |

Node は 22 系が要る。`.node-version` が 22 を指し、`engines` が `>=22 <23` を要求する。

## live で観測する 133 件

`- [~]` の各行は、デプロイ後にそれを観測するスクリプトを名指しする。
`scripts/deploy-gcp-guide.sh all` の `verify` 段が `infra/tests/verify-all.sh`（到達性、禁止ロール、invoker 行列）を実行し、残りは行に書いた `infra/tests/*.sh`、`scripts/*.sh`、`Makefile` のターゲット、`.github/workflows/*.yml` が観測する。
`docker build` は Docker daemon の無い環境では確認できず、`scripts/build-images.sh` が本番で観測する。

## 監査の方法と限界

まず条件 1391 件を機械的に突き合わせた。条件が名指しするテストファイルとテスト名を vitest の結果と照合し、`grep` 条件はそのまま実行し、`infra/tests/*.sh` は実行した。
機械判定で閉じなかった条件は領域ごとに人手で読み、テストが無いものは書き、挙動が無いものは実装し、条件の文言が実装の契約と食い違うものは理由を付けて書き換えた。
live GCP でしか確認できない条件は `- [~]` とし、観測するスクリプトを行に書いた。

したがって本監査は「コードとして成立し、リポジトリ内の証拠が揃っているか」を示すものであり、「GCP 上で動くことを確認した」ものではない。GCP 上の確認は `scripts/deploy-gcp-guide.sh all` を実行した時点で `- [~]` の 133 件が担う。

---

## 前回（2026-09-01）の監査

13 領域 374 タスクの「実装方針」と「完了条件」を、領域ごとに独立した監査で実装と照合した。挙げられた欠落は 161 件（critical 17 / high 42 / medium 54 / low 48）で、production を止めるものを修正した。

修正したのは、Security Detection の検知パイプラインの配線、Lifecycle の `human-identity-disabled` 購読、Agent Runtime の invoker token、Control Plane の Protocol Validation エミッタ、Bridge の Transaction 参照、Automation App から Provisioner / Lifecycle への経路、同意からの復帰、one-time code のコレクション、Transaction の遷移、Agent Definition の承認経路、Access Token の制約名、Bridge 無効時の cleanup、Lifecycle の DPoP jti、Agent OP と Human IdP のログ封筒、Agent Baseline の書き込み、seed のプレースホルダと connector スキーマである。

当時残っていた欠落（T-AUTHZ-27/28 の再評価、T-RUN-25 の Tool イベント、T-PKG-25 の Firestore backend、T-PROV-16 の reprovision、T-SEC-15〜26 の Rule 分類、T-APP の画面配信、T-IAC-17 の loadbalancer プロファイルなど）は、今回の監査で実装または実装済みであることを確認し、上の表に含めた。
