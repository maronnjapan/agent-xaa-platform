# 13. 文書整合と逸脱管理（T-DOCS）

この領域は、`docs/` 配下の設計文書を実装の確定内容へ一致させ、そのずれが再発しないように機械検査で固定する。
扱うのは4つある。
1つ目は要件と逸脱の台帳（`docs/requirements.md` と `docs/deviations.md`）、2つ目は設計ルールの機械可読化と改訂（`docs/rules.json` と `docs/10-design-rules.md`）、3つ目は単一 GCP プロジェクトと実装の識別子へ合わせた本文の書き換え、4つ目は用語辞書と構成図とリンクの整合検査である。
他領域が書くコードやインフラは扱わないが、逸脱表とトレーサビリティ表がそれらの成果物パスとテスト名を参照するため、参照先が実在することの検査はこの領域が持つ。

| 前提 | 内容 |
|---|---|
| 依存する領域 | 全実装領域（逸脱表とトレーサビリティ表が成果物パスとテスト名を引用する）。特に `packages/xaa-contracts`（定数）、`packages/xaa-crypto`（DPoP）、`infra/`（tfstate 検査） |
| このファイルのタスク数 | 17件 |
| 主に満たす設計ルール | RULE-45, RULE-34, RULE-42, RULE-32, RULE-33, RULE-47, RULE-53, RULE-57 |

---

### T-DOCS-01 全 REQ-ID の索引を docs/requirements.md へ起票する

**概要**
領域別に分かれている要件を1本の表へ集め、各 REQ-ID がどのタスクで扱われるかを追えるようにする。
どのタスクにも割り当たっていない要件を機械的に見つけるための土台になる。
`tasks/00-decisions.md` が「判断の根拠は本ファイルに書き、タスク側では繰り返さない」としているのと同じ役割を、要件側で担う。

**対象要件** なし（全 REQ-ID の索引を作るタスク。個々の要件の充足は各領域のタスクが担う）
**前提タスク** なし
**成果物**
- `docs/requirements.md`（新規）
- `scripts/check-requirements-index.ts`（新規）
- `tests/docs/requirements-index.test.ts`（新規）
- `package.json` の scripts に `check:requirements` を追加

**実装方針**
- 表の列を6つに固定する。`REQ-ID` / `表題` / `出典（docs のファイル名と節番号）` / `RULE` / `target` / `担当タスクID` / `状態`。
- `状態` は `planned`（担当タスクIDあり）と `deferred`（バックログ、担当タスクID列は `-`）の2値のみとする。3値目を作らない。
- 行の並びは `REQ-ID` の文字列昇順に固定する。領域ごとにグループ化しない。
- `scripts/check-requirements-index.ts` は次を検査して違反があれば `process.exit(1)` する。ID が `^REQ-\d{2}-\d{3}$` に一致すること、ID に重複が無いこと、`状態=planned` の行の担当タスクIDが `tasks/*.md` に見出しとして実在すること、`状態` が2値のいずれかであること。
- 担当タスクIDの実在確認は `tasks/*.md` から `^### (T-[A-Z]+-\d{2}) ` を抽出した集合との突き合わせで行う。ファイル名からの推測をしない。
- `deferred` の行には備考として先送り先のフェーズを書くが、列を増やさず表題列の末尾に `（deferred: P6）` の形で付ける。
- 要件本文の写経をしない。表題は要件ファイルの見出しをそのまま使う。

**完了条件**
- [x] `pnpm check:requirements` が exit code 0 で終了する
- [x] `docs/requirements.md` の行数（ヘッダ2行を除く）が、全領域の要件ファイルに現れる REQ-ID の総数（421）と一致する
- [x] `状態=planned` の行の担当タスクIDを1つ存在しない値へ書き換えると `pnpm check:requirements` が非 0 で終了する
- [x] `tests/docs/docs-registry.spec.ts::lists every requirement once, in ascending order` が ID の重複と欠落形式の検出を assert して緑になる

---

### T-DOCS-02 逸脱レジストリ docs/deviations.md を作る

**概要**
RULE-45 は、ドラフトから逸脱する箇所について「逸脱していること」と「相互運用を期待しない範囲」を文書に明示することを求めている。
確定済みの逸脱を4列表として起票し、以後の設計判断の変更がこの表を経由するようにする。
DEV-01 から DEV-15 の採番のうち DEV-07（FULL_ISOLATION のスロット方式）は取り下げる。
Dedicated OP は docs の記述どおり実行時に作り消すため、RULE-32 と RULE-33 に逸脱が生じない（DEC-IAC-07）。
`tasks/00-decisions.md` は本ファイルを逸脱の正本として参照している。

**対象要件** REQ-10-004
**前提タスク** なし
**成果物**
- `docs/deviations.md`（新規）

**実装方針**
- 表の列を `逸脱ID` に加えて4列とする。`逸脱した RULE / docs 節` / `代替実装（ファイルパス）` / `固定するテスト（パス::テスト名）` / `相互運用を期待しない範囲`。列を増やさない。
- 行は DEV-01 から DEV-15 まで並べ、内容は確定仕様の逸脱一覧をそのまま写す。要約したり言い換えたりしない。
- DEV-07 の行だけは「取り下げ」とし、`逸脱した RULE / docs 節` 列に「なし（DEC-IAC-07 により実行時作成へ戻したため RULE-32 と RULE-33 に逸脱なし）」、残る3列に `-` を書く。他の逸脱 ID を繰り上げない。既存の文書とタスクが DEV-08 以降を参照しているため、採番を動かさない。
- `固定するテスト` 列は `packages/xaa-crypto/test/dpop.spec.ts::rejects htu mismatch` の形式で書く。パスとテスト名を `::` で区切り、テスト名は実装側の `it(...)` の文字列と完全一致させる。1行に複数のテストを書く場合は ` / ` で区切る。
- 節 `## 2. REQ-10-004 が挙げる7件との対応` を置き、要件が列挙する7件と DEV-ID の対応を表にする。DPoP 非対応は DEV-01、private_key_jwt 非対応は DEV-02、受領側 grant_type は DEV-06、`cnf` claim は DEV-04、`actor_token` 独自プロファイルは DEV-03、監査ログの dataset 分離は DEV-14、FULL_ISOLATION は実行時作成のままとしたため逸脱を起票しない。
- REQ-10-004 の本文にある「Agent Client Credential は client_secret_basic」は確定判断で `client_assertion_jwt` へ置き換わっている。DEV-02 の記述を正とし、要件本文の旧記述を書き写さない。
- 節 `## 3. 逸脱ではないもの` を置き、`jwt-dpop` から `jwt-bearer` への訂正、ID-JAG の `aud` を URN にする案の不採用、`actor_token` 署名鍵を KMS に置くという docs 08 §9 の誤りの3件を書く。これらを逸脱表の行にしない。
- 節 `## 4. 逸脱を増やすときの手順` を置き、4列すべてを埋めること、DEV-ID を末尾に追番することを書く。既存 ID の再利用と欠番を禁じる。

**完了条件**
- [x] `docs/deviations.md` に `DEV-01` から `DEV-15` の15行がある
- [x] DEV-07 を除く14行で、`逸脱ID` を除く4列がすべて非空である
- [x] DEV-07 の行に「取り下げ」の文字列がある
- [x] REQ-10-004 が挙げる7件すべてに対応する DEV-ID が対応表に書かれている
- [x] `grep -c '^| \*\*DEV-' docs/deviations.md` の結果が 15 である
- [x] `grep -n 'client_secret_basic' docs/deviations.md` のヒットが、REQ-10-004 の本文が `client_assertion_jwt` へ置き換わったことを述べる §2 の注記1件だけになる（DEV-02 が正である旨をその場で示すため、置き換えられた側の名前をそこで1度だけ挙げる）

---

### T-DOCS-03 逸脱表の CI 検査 docs:deviations を作る

**概要**
逸脱表は4列すべてが埋まっていて初めて統制として機能する。
列の空欄と、存在しないファイルパスやテスト名の記載を CI で落とす。
実装がまだ無い段階でも表の完全性だけは常時検査できるよう、検査を2段階に分ける。

**対象要件** REQ-10-004
**前提タスク** T-DOCS-02
**成果物**
- `scripts/check-deviations.ts`（新規）
- `tests/docs/deviations.test.ts`（新規）
- `package.json` の scripts に `check:deviations` と `check:deviations:strict` を追加

**実装方針**
- `scripts/check-deviations.ts` は引数 `--strict` の有無で2モードを持つ。
- 既定モード（`--strict` なし）は、DEV-ID が `^DEV-\d{2}$` であること、ID が一意かつ01から連番であること、`逸脱ID` を除く4列がすべて非空であること（「取り下げ」と書かれた行は4列すべてが `-` または「なし」で始まる文字列であることだけを確認して次へ進む）、`固定するテスト` 列の全項目が `<path>::<name>` の形であること、`代替実装` 列に1つ以上のパス形式の文字列（`apps/`、`packages/`、`infra/`、`e2e/` のいずれかで始まる）が含まれることを検査する。
- `--strict` モードは既定モードに加えて、`代替実装` 列の各パスがファイルまたはディレクトリとして実在すること、`固定するテスト` 列の各 `path` が実在し、その中に `name` が `grep -F` で1件以上ヒットすることを検査する。
- どちらのモードも、違反を1行1件で標準エラーへ出し、1件でもあれば `process.exit(1)` する。違反時に警告だけ出して 0 で終わる分岐を作らない。
- CI ジョブ名は既定モードが `docs:deviations`、strict モードが `docs:deviations-strict` とする。`docs:deviations` は本タスクの時点で必須ジョブにし、`docs:deviations-strict` は全実装フェーズ完了後に必須化する。この切り替え時期を `docs/deviations.md` の節4に書く。
- `tests/docs/deviations.test.ts` は、7件の対応表の存在、15行の存在、および1列を空にした一時コピーに対して既定モードが非 0 を返すことを assert する。

**完了条件**
- [x] `pnpm check:deviations` が exit code 0 で終了する
- [x] `docs/deviations.md` の任意の1行の `相互運用を期待しない範囲` 列を空にすると `pnpm check:deviations` が非 0 で終了する
- [x] `固定するテスト` 列のテスト名を1つ実在しない文字列へ変えると `pnpm check:deviations:strict` が非 0 で終了する
- [x] CI 定義の `docs` ジョブが `pnpm check:deviations` を必須で実行する（CI は単一の ci.yml に集約してある）

---

### T-DOCS-04 設計ルールを docs/rules.json と生成スクリプトへ移す

**概要**
RULE-01 から RULE-60 を手書きの Markdown 表から機械可読な JSON へ移し、Markdown 側を生成物にする。
以後のルール改訂を JSON の1か所で行い、表と本文の乖離を構造的に無くす。
RULE 改訂そのものは T-DOCS-05 で行い、本タスクは移行と生成の仕組みだけを作る。

**対象要件** REQ-10-001
**前提タスク** なし
**成果物**
- `docs/rules.json`（新規）
- `scripts/gen-design-rules.ts`（新規）
- `tests/docs/rules-registry.test.ts`（新規）
- `docs/10-design-rules.md`（生成物へ差し替え）
- `package.json` の scripts に `gen:design-rules` を追加

**実装方針**
- `docs/rules.json` のトップレベルを `{ "version": 1, "preamble": string, "categories": Category[], "rules": Rule[] }` とする。
- `Category` は `{ "id": string, "title": string }` とし、id は `identity` / `authorization` / `capability-tool` / `xaa-bridge` / `lifecycle` / `isolation` / `gcp` / `monitoring` / `activity-timeline` の9値に固定する。title は現行の `docs/10-design-rules.md` の見出し文字列をそのまま使う。
- `Rule` は `{ "id": "RULE-01", "category": Category["id"], "text": string, "sources": Source[] }`、`Source` は `{ "label": "05. §6.3", "doc": "05-identity.md", "anchor": "#63-agent-opの検証手順" }` とする。
- `text` は現行の表のルール文をそのまま移す。この時点で文面を変えない。
- `scripts/gen-design-rules.ts` は `docs/rules.json` から `docs/10-design-rules.md` 全体を生成する。見出し、前文、カテゴリごとの表、出典リンク（`[{label}]({doc}{anchor})` 形式）をすべて生成対象にする。手書き部分を残さない。
- 生成順は `categories` の配列順、カテゴリ内は `rules` の配列順とする。ID 順へ並べ替えない（現行の並びが ID 昇順でないため）。
- `tests/docs/rules-registry.test.ts` は、`rules` の件数が60であること、`id` が `RULE-01` から `RULE-60` まで欠番と重複が無いこと、`category` が9値のいずれかであること、`sources` が1件以上あることを assert する。
- JSON の整形は2スペースインデント、キー順は上記の宣言順に固定する。

**完了条件**
- [x] `pnpm gen:design-rules` の実行後に `git diff --exit-code docs/10-design-rules.md` が 0 を返す
- [x] `pnpm vitest --project unit run tests/docs` の `the rules registry` が緑になる
- [x] `docs/rules.json` の `rules` の件数が 60 で、`RULE-` の連番に欠番が無い
- [x] `docs/rules.json` の任意の1件の `text` を書き換えて `pnpm gen:design-rules` を実行すると `docs/10-design-rules.md` に差分が出る

---

### T-DOCS-05 確定判断に合わせて RULE 10件を改訂する

**概要**
DPoP の実装位置、単一プロジェクト、issuer の配置、JWKS の書き込み範囲、Firestore Security Rules の不採用を、ルール本文へ反映する。
改訂しないまま残すと、逸脱表の行と RULE 本文が食い違い、どちらが正かが判断できなくなる。
対象は RULE-06 / 32 / 33 / 34 / 42 / 44 / 47 / 49 / 53 / 57 の10件で、RULE-50 は文面を変えない。

**対象要件** REQ-10-001, REQ-10-008, REQ-10-009
**前提タスク** T-DOCS-04
**成果物**
- `docs/rules.json`（10件の `text` 更新と `revised_from` 追加）
- `docs/10-design-rules.md`（再生成）
- `docs/README.md`（変更履歴へ1行追記）

**実装方針**
- `Rule` に任意フィールド `revised_from`（改訂前の `text`）と `revised_reason`（改訂の根拠となる判断ID、例 `DEC-IAC-07`）を追加する。改訂した10件にだけ付ける。`tests/docs/rules-registry.test.ts` に「`revised_from` があるなら `revised_reason` も非空」の assert を足す。
- 改訂後の `text` を次で確定する。言い換えず、この文をそのまま入れる。
- RULE-06：「Human Control Plane の Access Token は DPoP-bound とする。Agent Runtime から Agent OP への Token Exchange と Native Resource AS への提示でも DPoP を必須とし、ID-JAG を `cnf.jkt` で束縛する。DPoP はライブラリの機能ではなく `packages/xaa-crypto` の自前実装であり、対応するのは Runtime から Agent OP、Runtime から Resource AS と Resource API、Automation App から Control Plane の3経路に限る。Bridge から外部 SaaS への外向きは Bearer とする」
- RULE-44：「DPoP 検証では、Access Token の `cnf.jkt` と DPoP Proof の鍵の一致を必ず確認する。Access Token と併用する Proof には `ath` を必須とし、検証は 署名、typ、htm、htu、iat 窓、jti 重複、ath 一致 の順で行う。Proof が添付されていることの確認だけで済ませない」
- RULE-32：改訂しない。「FULL_ISOLATIONはDedicated OP、専用Service Account、専用KMS Key、専用Job定義、専用IAM Bindingを持つ」は実装のとおりである。同時に存在できる Agent 数の上限（`max_full_isolation_agents`、既定 5）は制約であってルールの変更ではないため、docs 05 §5 の本文へ追記する（T-DOCS-07）
- RULE-33：改訂しない。「Dedicated OPのService Accountは、そのAgentの鍵にだけ署名できる」は実装のとおりである。Firestore のパス単位の分離が IAM で表現できずアプリ側のパスガードに依存する点だけを、docs 08 §7.2 の注記として書く
- RULE-34：「実行系と監査ログを同一 GCP Project 内で、BigQuery dataset と Service Account と IAM で分離する。Platform 側の Service Account に監査 dataset の削除権限を与えない。同一プロジェクトの Owner は実行系と監査ログの両方に届くため、プロジェクトを分ける構成より保護は弱い」
- RULE-42：「Platform 側の Service Account に Security Log の削除権限を与えない。監査 dataset の IAM は authoritative な binding で固定し、削除可能なロールを一切付与しないことで満たす」
- RULE-47：「Human IdP に Agent の文脈を持ち込まない。issuer は1つに保ち、Agent の文脈は別デプロイへ分ける。パスに置くか別ホストに置くかは配置プロファイル `issuer_profile` で選ぶ」
- RULE-49：「Token Exchange では、`actor_token` が指す Agent Registration の `human_subject` と `subject_token` の `sub` の一致を必ず確認する。照合は actorTokenResolver の内側ではなく、subject と actor が揃った位置に置いた自前ステップで行う」
- RULE-53：「共有 JWKS はアプリではなく Cloud Storage から配信する。各アプリは自分専用のオブジェクト `keys/<prefix>-<kid>.json` だけを書き、`jwks.json` への集約は jwks-publish Job が行う」
- RULE-57：「ブラウザは Firestore へ直接アクセスしない。Firestore Security Rules は作らず、フロントに Firestore SDK と Firebase Auth を含めないことと、サーバ側のパスガードで担保する」
- RULE-50 は `text` を変えない。`revised_from` も付けない。Agent 個体の識別が `cnf.jkt` と `act` と監査ログの3つである点は現行文のままで足りる。
- 出典（`sources`）は変更しない。改訂で参照節が変わるのは RULE-34 と RULE-47 だが、節番号は T-DOCS-06 と T-DOCS-07 で本文を書き換えた後も同じ番号を保つため、アンカーの張り替えを行わない。
- `docs/README.md` の変更履歴の末尾へ「2026-08-30：制約（単一 GCP Project、IaC 管理）に合わせて RULE-06 / 32 / 33 / 34 / 42 / 44 / 47 / 49 / 53 / 57 を改訂した。改訂前の文面は `docs/rules.json` の `revised_from` に残る」を追記する。

**完了条件**
- [x] `docs/rules.json` で `revised_from` を持つ件数が 8 で、その ID 集合が RULE-06 / 34 / 42 / 44 / 47 / 49 / 53 / 57 と一致する（実装方針が RULE-32 と RULE-33 を「改訂しない」と定めたため、`revised_from` はこの8件に付く）
- [x] `pnpm gen:design-rules` の実行後に `git diff --exit-code docs/10-design-rules.md` が 0 を返す
- [x] `grep -n 'agent-security-prod' docs/10-design-rules.md` がヒット 0 件になる
- [x] `grep -n 'パスでデプロイを分ける' docs/10-design-rules.md` がヒット 0 件になる
- [x] `pnpm vitest run tests/docs/docs-registry.spec.ts` が緑になる（rules registry の検査は 00b のテスト配置に従いこのファイルにある）

---

### T-DOCS-06 docs 08 §1 と docs 09 §4 を単一プロジェクト構成へ書き換える

**概要**
制約2により GCP プロジェクトは1つになり、監査ログの分離はプロジェクト境界ではなく BigQuery dataset と IAM で行う。
2プロジェクト前提の記述が残ると、Terraform の構成と文書が食い違い、保護が実際より強く読める。
プロジェクト分離をやめたことで弱まる範囲も同じ節に書く。

**対象要件** REQ-10-008
**前提タスク** T-DOCS-05
**成果物**
- `docs/08-gcp-infrastructure.md`（§1 の書き換え）
- `docs/09-security-monitoring.md`（§4 の書き換え）
- `scripts/check-legacy-project-name.sh`（新規）
- `package.json` の scripts に `check:legacy-names` を追加

**実装方針**
- docs 08 §1 の見出しを `## 1. GCP Projectと監査領域の構成` へ変える。アンカーは `#1-gcp-projectと監査領域の構成` になるため、これを参照する `docs/09-security-monitoring.md` のリンクと `docs/rules.json` の RULE-34 の `anchor` も同時に更新する。
- §1 の2行の表を、プロジェクト1行と監査領域1行の表へ置き換える。プロジェクト行に「実行系のすべて。Cloud Run Service と Job、Firestore、Cloud KMS、Secret Manager、Pub/Sub、Cloud Logging、BigQuery、Vertex AI」、監査領域行に「同一プロジェクト内の BigQuery dataset `security_audit`。専用 Service Account `sa-security` と authoritative な `google_bigquery_dataset_iam_binding` で固定する」と書く。
- §1 に3層の統制を箇条書きで書く。dataset と専用 SA と authoritative binding、Log Sink の writer identity にだけ書き込みを許すこと、変数 `enable_deny_policy`（既定 false）による IAM Deny Policy の3つ。
- §1 の末尾に太字で保護の弱まりを明記する。「同一プロジェクトの Owner は実行系と監査ログの両方に届く。プロジェクトを分ける構成より保護は弱い。`enable_deny_policy=false` のとき、Owner による監査ログの削除は防げない」と書く。この文を注記や脚注へ落とさず本文に置く。
- docs 09 §4 の保存経路のコードブロックを `各アプリ → Cloud Logging → Log Sink → BigQuery dataset security_audit` へ書き換える。Pub/Sub を経路に書かない。
- docs 09 §4 の末尾のリンク文を「Platform 側の Service Account には監査 dataset の削除権限を与えない」へ書き換え、参照先を docs 08 §1 の新アンカーにする。
- `infra/README.md` への同趣旨の明記は infra 領域が行う。本タスクは docs 側だけを変更する。
- `scripts/check-legacy-project-name.sh` は `docs/` 配下で `agent-security-prod` を検索し、`docs/deviations.md` と `docs/README.md` の2ファイル以外にヒットがあれば非 0 で終了する。許容する2ファイルでも、ヒット行に `旧設計` の文字列が無ければ非 0 で終了する。

**完了条件**
- [x] `pnpm check:legacy-names` が exit code 0 で終了する
- [x] `grep -rn 'agent-security-prod' docs/ --include='*.md'` のヒットが `docs/deviations.md` と `docs/README.md` の2ファイルに限られる
- [x] `docs/08-gcp-infrastructure.md` の §1 に `security_audit` と `enable_deny_policy` の両方の文字列がある
- [x] `pnpm check:docs-links` が docs 08 §1 の新アンカーを解決できる（T-DOCS-13 完了後に再確認する）

---

### T-DOCS-07 FULL_ISOLATION の記述を実装の識別子へ合わせる

**概要**
docs 05 §5 と docs 07 §3.3 と docs 08 §5 は、Dedicated OP と専用 SA と専用鍵を Provisioning 時に作り Cleanup で消すと書いており、実装もそのとおりにする（DEC-IAC-07）。
方式そのものに変更は無く、書き換えるのは識別子の形と、実行時作成に伴う運用上の制約の追記である。

**対象要件** REQ-10-009
**前提タスク** T-DOCS-05
**成果物**
- `docs/05-identity.md`（§5 の識別子と追記）
- `docs/08-gcp-infrastructure.md`（§4.2 と §5 と §6.1 の識別子）
- `docs/07-lifecycle.md`（§6 の Cleanup 手順の追記）

**実装方針**
- Agent 名を含む識別子 `dedicated-op-<agent>` と `sa-op-<agent>` と `sa-agent-<agent>` を、実装の名前 `dedicated-op-<short>` と `sa-op-<short>` と `sa-agent-<short>` へ改める。
  `<short>` が `agent_id` の乱数部の末尾12文字であることを docs 05 §5 に1文で書く。
  Service Account の `account_id` が6文字以上30文字以内という GCP の制限に収めるための短縮であることを理由として添える。
- docs 05 §5 の比較表の `ID-JAG署名鍵（KMS）` 行の FULL_ISOLATION 側を「Agent ごとに1つ（`idjag-<short>`）。その Agent の Service Account のみ署名可」へ、`Agent Runtime` 行を「専用 Job `agent-runtime-<short>` と専用 SA `sa-agent-<short>`」へ、`IAM Binding` 行を「`sa-agent-<short>` から `dedicated-op-<short>` のみ」へ変える。
- 「FULL_ISOLATIONの例」のコードブロックのリソース名を上記の形へ揃える。
- 同節へ小見出し `#### 実行時作成に伴う制約` を追加し、次の3点を書く。
  同時に存在できる FULL_ISOLATION Agent の上限が `max_full_isolation_agents`（既定 5）であり、その理由が Project あたりの Service Account 数の上限（既定100）と、削除した Service Account が30日間その枠を占め続ける GCP の制限であること。
  上限に達したとき Policy Engine は STANDARD へ降格せず、Provisioner が 503 `full_isolation_capacity_reached` を返すこと。
  KMS の CryptoKey は削除できないため、Cleanup は鍵バージョンの破棄予約までを行い、空の CryptoKey が Key Ring に残ること。破棄予約された鍵バージョンに課金は発生しない。
- 「Provisioning分岐」の mermaid の `CLASS -->|FULL_ISOLATION| DEDICATED[Deploy Dedicated OP + Dedicated Runtime + IAM]` はそのまま残す。
  実装がこのとおりであるため書き換えない。
- docs 08 §5 の `sa-provisioner` 行の「付与する」列を、カスタムロール名まで含めた形へ具体化する。
  「Cloud Run Service と Job の作成（`dedicated_op_creator`）」「Service Account の作成（`dedicated_sa_creator`）」「`idjag-signing` と `idp-connection-encryption` の Key Ring への `roles/cloudkms.admin`」を書く。
  「付与しない」列へ「`roles/run.admin`。`roles/iam.serviceAccountAdmin`。`roles/owner`。KMS の署名権限」を追加する。
- `sa-lifecycle` 行の「付与する」列へ「Cloud Run Service と Job と Service Account の削除（`dedicated_op_destroyer`）」と「KMS 鍵バージョンの破棄予約」を書き、「付与しない」列へ `sa-provisioner` と同じ4件を書く。
- §5 直後の「`sa-provisioner` と `sa-lifecycle` はCloud Run ServiceやService Account、KMS Keyを作成および削除できるため、Project内で最も強い権限を持つ」という段落は残す。
  実装がこのとおりであるため削らない。
  その段落へ「触れてよい対象は `dedicated-op-` と `sa-op-` と `sa-agent-` と `idjag-` と `idpconn-` と `agent-runtime-` の6接頭辞で始まり、ラベル `xaa-managed=runtime` を持つものに限る。この境界は IAM では表現できないため、アプリ側の `assertRuntimeName` と CI の静的検査で担保する」を1文追記する。
- docs 08 §6.1 の `idjag-signing` 行の使う者の列を `sa-op-<short>` へ変える。
- docs 07 §6 の Cleanup 手順の step8 と step9 へ「削除対象は Firestore の `dedicated_resources/{agent_id}` に記録した完全修飾名から取り、作成の逆順で消す」を追記する。

**完了条件**
- [x] `grep -rn 'dedicated-op-<agent>\|sa-op-<agent>\|sa-agent-<agent>' docs/ --include='*.md'` のヒットが 0 件になる
- [x] `docs/05-identity.md` の §5 に `max_full_isolation_agents` と `full_isolation_capacity_reached` の両方の文字列がある
- [x] `docs/05-identity.md` に `#### 実行時作成に伴う制約` の小見出しが1つある
- [x] `docs/08-gcp-infrastructure.md` に `dedicated_op_creator` と `dedicated_op_destroyer` と `xaa-managed=runtime` の3つの文字列がある
- [x] `docs/07-lifecycle.md` に `dedicated_resources` の文字列がある

---

### T-DOCS-08 データストアの記述を Firestore 1本へ統一する

**概要**
確定判断でデータストアは Firestore（Native mode）1本になり、Cloud SQL を既定構成では使わない。
docs 01 §3.1、docs 08 §5、docs 08 §7 に Cloud SQL 前提の記述が残っており、これが構成図とサービス一覧にも波及している。
データ層の責務分離が GRANT ではなくアプリ側のパスガードで行われることも同じ節に書く。

**対象要件** なし（DEC-IAC-09 と DEV-05 に対応する文書整合。要件由来ではない）
**前提タスク** T-DOCS-02
**成果物**
- `docs/01-overview.md`（§3.1 の注記の書き換え）
- `docs/08-gcp-infrastructure.md`（§5、§7、§9 の書き換え）

**実装方針**
- docs 01 §3.1 の「Tool / Connector Catalogはアプリではなく、Cloud SQL上の定義データ（`tool_catalog`）と、それを読むProvisioner内のロジックである」を「Tool / Connector Catalog はアプリではなく、Firestore のコレクション `catalog/tools` と `catalog/connectors` に置く定義データと、それを読む Provisioner 内のロジックである」へ書き換える。
- docs 08 §7 の見出し構成を保ったまま、Cloud SQL のテーブル定義を Firestore のコレクション定義へ置き換える。コレクション名は `agents` / `dedicated_resources` / `catalog/tools` / `catalog/connectors` / `idp_connections` / `documents` / `payments` / `authorization` / `capability_taxonomy` を使い、これ以外を作らない。
- docs 08 §7.1 の論理DB分離（DB User による分離）の記述を削除し、「データ層の責務分離は DB の GRANT ではなく、`packages/gcp/src/firestore-guard.ts` の許可マトリクスによるパスガードで強制する。IAM はデータベース単位の `roles/datastore.user` のみを付与する」へ差し替える。同じ段落に DEV-05 へのリンクを置く。
- docs 08 §5 の各 Service Account 行から `Cloud SQL（...）` の記述を消し、`Firestore（<コレクション名>）` へ置き換える。コレクション名は前項の9個から選ぶ。
- docs 08 §9 の使用するGCPサービス一覧から Cloud SQL の行を削除する。同じ表にある「Cloud KMS: actor_token 署名鍵」の行も削除する（`actor_token` の鍵は Execution 内にのみ存在し KMS に置かないため）。
- Cloud SQL を将来使う可能性についての記述を追加しない。

**完了条件**
- [x] `grep -rn 'Cloud SQL' docs/ --include='*.md'` のヒットが `docs/requirements.md` の「Cloud SQL 不採用」を表題に持つ要件行のみになる（設計文書からは消え、要件索引の表題だけが不採用の判断として残る）
- [x] `docs/08-gcp-infrastructure.md` の §7 に現れるコレクション名が、実装方針に列挙した9個の集合に含まれる
- [x] `grep -n 'actor_token 署名鍵\|actor_token署名鍵' docs/08-gcp-infrastructure.md` のヒットが 0 件になる
- [x] `docs/08-gcp-infrastructure.md` の §7.1 に `firestore-guard.ts` と `DEV-05` の両方の文字列がある

---

### T-DOCS-09 用語辞書 docs/glossary.md を作る

**概要**
docs 01 の §3.2 から §3.4 で定義した用語について、対応する型名とコレクション名と API フィールド名を1対1で並べる。
同じ概念に別名が生まれるのを防ぐことが目的で、確定済みの Capability と scope と Tool ID の対応もここに置く。
辞書の内容を検査するスクリプトは T-DOCS-10 で作る。

**対象要件** REQ-01-021
**前提タスク** T-DOCS-08
**成果物**
- `docs/glossary.md`（新規）
- `docs/glossary.forbidden.txt`（新規）
- `docs/01-overview.md`（§3.4 の末尾に glossary への参照を1行追加）

**実装方針**
- 表の列を4つに固定する。`用語` / `定義（1文）` / `実装識別子` / `定義元`。
- 収録は26行とする。内訳を次で確定する。docs 01 §3.3 の6語（Human Permission、Delegatable Permission、Organization Policy、Risk Policy、Authorization AI Proposed Capability、Effective Agent Permission）、docs 01 §3.4 の18語（Work Definition、Capability、Capability Taxonomy、Tool、Connector、Tool / Connector Catalog、Cross App Access、ID-JAG、Agent OP、subject_token、actor_token、Human IdP Connection、Agent Registration、OAuth Bridge、Native XAA Resource、Security Profile、Isolation Level、Agent Identity Domain）、docs 01 §3.2 の2語（Human Identity、Agent Identity）である。27行目を作らない。
- `実装識別子` 列には、TypeScript の型名（`packages/xaa-contracts` または `apps/*/src` に定義されるもの）、Firestore のコレクション名、API のフィールド名のうち該当するものを ` / ` 区切りで書く。実装が未着手で対応する識別子が無い語は `-` と書く。推測した名前を書かない。
- 各行の `定義元` は `01. §3.4` の形式で書く。docs 05 などの詳細節への二重リンクを付けない。
- 表の後に節 `## 2. 確定した命名` を置き、Capability 8件、Resource AS の scope 7件、Tool ID 7件を表で列挙する。値は確定仕様のものをそのまま使う。
- 節 `## 3. 使わない別名` を置き、破棄した別名を列挙する。最低限、`document.content.read`、`document.content.write`、`documents.read`、`docs.document.read`、`docs.document.write`、`transactions.read`、`transfers.write`、`finance.transaction.read`、`internal.customer.`、`google.calendar.events.list` を含める。
- `docs/glossary.forbidden.txt` に上記の別名を1行1件で書く。コメント行は `#` で始める。この一覧を T-DOCS-10 の検査が読む。
- docs 01 §3.4 の表の直後に「用語と実装識別子の対応は [用語辞書](./glossary.md) にある」を1行追加する。§3.3 と §3.4 の表そのものは削除しない。

**完了条件**
- [x] `docs/glossary.md` の第1表の行数（ヘッダ2行を除く）が 26 である
- [x] 第1表の `用語` 列の集合が、docs 01 §3.2 の2語と §3.3 の6語と §3.4 の18語の和集合と一致する
- [x] `docs/glossary.md` の節2に Capability 8件、scope 7件、Tool ID 7件がすべて列挙されている
- [x] `docs/glossary.forbidden.txt` が10件以上の別名を含み、コメント行以外に空行が無い

---

### T-DOCS-10 用語辞書の実在検査と別名検出を作る

**概要**
辞書に書いた実装識別子がリポジトリに実在すること、破棄した別名がコードへ入り込んでいないことを機械検査する。
辞書が実装から離れて古くなるのを防ぐ。
逸脱表と同じく、実装が進む前でも動くよう検査を2段階に分ける。

**対象要件** REQ-01-021
**前提タスク** T-DOCS-09
**成果物**
- `scripts/check-glossary.ts`（新規）
- `tests/docs/glossary.test.ts`（新規）
- `package.json` の scripts に `check:glossary` と `check:glossary:strict` を追加

**実装方針**
- `scripts/check-glossary.ts` の既定モードは、第1表が26行であること、`用語` 列に重複が無いこと、`定義元` 列が `^\d{2}\. §[\d.]+$` に一致すること、`docs/glossary.forbidden.txt` の各別名が `apps/`、`packages/`、`e2e/`、`infra/`、`demo-scenarios/` 配下のファイルに1件も出現しないこと（`rg -F --glob '!node_modules'` で検索）を検査する。
- `--strict` モードは既定モードに加えて、`実装識別子` 列の各項目が `apps/`、`packages/`、`infra/` 配下に `rg -F` で1件以上ヒットすることを検査する。`-` の行は既定モードでは許し、`--strict` では違反として扱う。
- 別名の検索対象から `docs/` を除く。`docs/glossary.md` の節3と `docs/deviations.md` は別名を意図的に列挙するため、検査でヒットさせない。
- 違反は1行1件で標準エラーへ出し、1件でもあれば `process.exit(1)` する。
- `tests/docs/glossary.test.ts` は、26行であること、節2の Capability 8件が `packages/xaa-contracts` の Capability 定数と集合として一致することを assert する。定数が未定義の場合はテストを skip せず失敗させる。
- CI ジョブ名は既定モードが `docs:glossary`、strict モードが `docs:glossary-strict` とする。strict は全実装フェーズ完了後に必須化し、その時期を `docs/glossary.md` の冒頭に書く。

**完了条件**
- [x] `pnpm check:glossary` が exit code 0 で終了する
- [x] `docs/glossary.forbidden.txt` の別名を1つ `packages/` 配下の任意のファイルへ書き足すと `pnpm check:glossary` が非 0 で終了する
- [x] `docs/glossary.md` の第1表から1行削除すると `pnpm check:glossary` が非 0 で終了する
- [x] `pnpm vitest --project unit run tests/docs` の用語検査が緑になる（docs 検査は `tests/docs/docs-registry.spec.ts` に集約した）

---

### T-DOCS-11 構成図を単一プロジェクト構成へ更新して再生成する

**概要**
`docs/diagrams/generate.py` のレイアウト定義を書き換え、png と svg と drawio を再生成する。
現行の図は2プロジェクト、Agent 単位の Dedicated OP、Resource 1種、Cloud SQL を描いており、いずれも確定構成と異なる。
図は docs 01 §4 と docs 08 の冒頭から同じファイルが参照される。

**対象要件** REQ-01-026
**前提タスク** T-DOCS-06, T-DOCS-07, T-DOCS-08
**成果物**
- `docs/diagrams/generate.py`（`NODES` と `EDGES` の書き換え）
- `docs/diagrams/architecture.drawio`（再生成）
- `docs/diagrams/architecture.svg`（再生成）
- `docs/diagrams/architecture.png`（再生成）
- `package.json` の scripts に `gen:diagrams` を追加

**実装方針**
- `g_platform` のラベルを `agent-xaa-platform（単一 GCP Project）` へ変える。
- `g_security` グループを削除し、`bq` ノードを `g_tel`（Telemetry）枠の内側へ移す。ラベルを `BigQuery（dataset: security_audit）` にする。枠のサイズは `g_platform` の高さを 820 から 700 前後へ詰めて調整する。
- `dop` ノードのラベルを `Dedicated OP Slot ×N|Terraform 事前作成 / Provisioner がリース` へ変える。ノード ID は `dop` のまま変えない（`EDGES` の参照を壊さないため）。
- `sql` ノードを `NODES` から削除し、`sql` を端点に持つ `EDGES` の行も削除する。`ICONS` の `sql` エントリは残してよい。
- `g_native` を2つの枠へ分ける。`g_docs`（ラベル `Document Resource`、`nas_docs` と `napi_docs` を内包）と `g_fin`（ラベル `Finance Resource`、`nas_fin` と `napi_fin` を内包）。既存の `nas` と `napi` は `nas_docs` と `napi_docs` へ改名し、`EDGES` の参照も追随させる。
- `g_google` 枠と `gb`（Google Bridge）ノードを破線で描く。`NODES` のタプルへ7要素目として `dashed: bool` を足すのではなく、`GROUP_DASHED = {"g_google"}` と `NODE_DASHED = {"gb"}` の集合を定義し、`emit_drawio` と `emit_svg` の両方で参照する。ラベルへ `enable_google_bridge=true のときのみ` を改行で追記する。
- 色を増やさない。白黒と GCP 公式アイコンという現行方針を変えない。
- `package.json` の `gen:diagrams` は `python3 docs/diagrams/generate.py` を呼ぶだけにする。CI では svg と drawio のみ `git diff --exit-code` の対象にし、png は cairosvg の有無で差分が出るため対象から外す。
- docs 01 §4 と docs 08 冒頭の画像参照パスは変更しない。

**完了条件**
- [x] `python3 docs/diagrams/generate.py` が exit code 0 で終了し、drawio と svg と png の3ファイルが更新される
- [x] `grep -c 'agent-security-prod' docs/diagrams/architecture.svg` の結果が 0 である
- [x] `grep -c 'Dedicated OP' docs/diagrams/architecture.svg` と `grep -c 'Document Resource' docs/diagrams/architecture.svg` と `grep -c 'Finance Resource' docs/diagrams/architecture.svg` がいずれも 1 以上である（Slot 方式は DEC-IAC-07 で実行時作成へ戻ったため、ラベルから `Slot` を外した）
- [x] `grep -c 'Cloud SQL' docs/diagrams/architecture.svg` の結果が 0 である
- [x] `pnpm gen:diagrams` を2回連続で実行しても `git diff --exit-code docs/diagrams/architecture.svg docs/diagrams/architecture.drawio` が 0 を返す

---

### T-DOCS-12 docs 02 の例示シナリオを検証用リソースサーバー2種へ書き換える

**概要**
docs 02 の対話例と Agent Definition 例が Google Calendar を前提にしているが、既定構成では Google Bridge が無効で動かない。
標準シナリオを Document Resource の読み書きへ差し替え、高セキュリティシナリオは Finance の `financial_operation` を維持する。
Google の例は Bridge を有効にしたときの任意例として付録へ移す。

**対象要件** REQ-02-031
**前提タスク** T-DOCS-09
**成果物**
- `docs/02-automation-design.md`（§1、§3、§4 の書き換えと付録 A の追加）
- `tests/docs/example-capabilities.test.ts`（新規）

**実装方針**
- §1 の対話例を、日報から業務記録の要約を提案する流れへ書き換える。最終行の Automation Design AI の応答を「Document Resource から当日の業務記録を読み、要約を日報ドキュメントへ書き込む」という作業内容にする。
- §3 の `business_work_request` の `purpose` を `daily_work_log_summary` へ、`description` を「Document Resource から当日の業務記録を取得し、要約を日報ドキュメントとして書き込む」へ変える。`constraints.external_message_send: false` はそのまま残す。`requested_lifetime_hours` は 24 のままにする。
- §4 の1つ目の `agent_definition` の `agent_purpose` を `daily_work_log_summary`、`operations` を `retrieve_work_logs` と `summarize_work_logs` と `write_daily_report` の3つ、`effective_capabilities` を `document.read` と `document.write` の2つ、`security_profile.isolation_level` を `standard` にする。
- Capability 名は確定した `document.read` と `document.write` を使う。REQ-02-031 の本文にある `document.content.read` と `document.content.write` は破棄済みの別名であり、書かない。
- §4 の2つ目の高セキュリティ例は `financial_operation` と `finance.payment.read` と `finance.payment.approve` と `full_isolation` をそのまま維持する。`human_subject: user-456` も変えない（デモ D-4 がこの subject を使う）。
- 文書末尾に `## 付録 A. Google Bridge を有効にした場合の例` を追加し、現行の Calendar の対話例と `calendar.event.read` の Agent Definition をそこへ移す。付録の冒頭に「この例は `enable_google_bridge=true` のときにのみ成立する。既定の apply では Bridge 関連サービスを作らないため動作しない」と書く。
- 本文（§1 から §5）から `calendar` の文字列を残さない。付録にだけ残す。
- `tests/docs/example-capabilities.test.ts` は `docs/02-automation-design.md` の付録より前の部分から ```yaml ブロックを抽出し、`effective_capabilities` の全値が `packages/xaa-contracts` の Capability 定数の集合に含まれることを assert する。付録部分は抽出対象から除く。

**完了条件**
- [x] `docs/02-automation-design.md` の付録 A より前の部分に `calendar` の文字列が現れない
- [x] 本文の `agent_definition` ブロックが2つで、`effective_capabilities` の値が `document.read` / `document.write` / `finance.payment.read` / `finance.payment.approve` の4つのみである
- [x] 付録 A の冒頭に `enable_google_bridge=true` の文字列がある
- [x] `pnpm vitest --project unit run tests/docs` の `the worked example in docs 02` が緑になる（docs 検査は 00b のテスト配置に従い `tests/docs/docs-registry.spec.ts` に集約した）

---

### T-DOCS-13 docs の相互参照リンクとアンカーを検査する

**概要**
docs 10 の60行が出典として張るアンカーと、docs 09 と docs 11 の相互参照は、節の見出しを変えると静かに壊れる。
T-DOCS-06 と T-DOCS-07 で見出しを変えるため、リンク切れを CI で落とす仕組みが要る。
検査対象は docs 配下のすべての Markdown にする。

**対象要件** REQ-10-002
**前提タスク** T-DOCS-06
**成果物**
- `scripts/check-docs-links.ts`（新規）
- `tests/docs/links.test.ts`（新規）
- `package.json` の scripts に `check:docs-links` を追加

**実装方針**
- 対象は `docs/**/*.md` のすべてとする。`docs/10-design-rules.md` だけを対象にしない。
- 抽出するのは Markdown のインラインリンク `[text](target)` と画像 `![alt](target)` の2形式のみ。参照形式リンクと HTML の `<a>` は使わない規約とし、見つかった場合は違反として報告する。
- `target` が `http://` または `https://` で始まるものは検査せず読み飛ばす。ネットワークアクセスを行わない。
- `target` にファイルパス部分があれば、リンク元ファイルからの相対パスとして実在を確認する。
- `target` にアンカー（`#` 以降）があれば、リンク先ファイルの見出し行（`^#{1,6} `）から slug を生成した集合に含まれることを確認する。slug 生成は、見出し文字列から `#` と前後の空白を除き、小文字化し、`[ 　]` を `-` へ置換し、`` ` `` と `（`、`）`、`(`、`)`、`.`、`,`、`:`、`/`、`：`、`、` を削除する、という順で行う。日本語文字はそのまま残す。この規則をスクリプト冒頭のコメントに書く。
- 同一ファイル内アンカー（`#` で始まる target）も同じ規則で検査する。
- 違反は `docs/10-design-rules.md:42 -> ./05-identity.md#63-... (anchor not found)` の形式で1行1件出し、1件でもあれば `process.exit(1)` する。
- `tests/docs/links.test.ts` は、正常な docs 一式に対して違反 0 件になること、および一時ディレクトリへコピーした docs のアンカーを1つ壊すと違反 1 件で非 0 になることを assert する。実リポジトリのファイルを書き換えて戻す方式にしない。
- CI ジョブ名は `docs:links` とし、必須ジョブにする。

**完了条件**
- [x] `pnpm check:docs-links` が exit code 0 で終了する
- [x] `tests/docs/docs-registry.spec.ts::reports a broken anchor rather than passing it over` が緑になる
- [x] `docs/10-design-rules.md` の60行のリンクがすべて解決される（違反 0 件の出力で確認する）
- [x] `docs/09-security-monitoring.md` と `docs/11-activity-timeline.md` の本文リンクが検査対象に含まれる（`--verbose` で対象ファイル一覧に両方が出る）

---

### T-DOCS-14 RULE と実装とテストの対応表を作る

**概要**
RULE-01 から RULE-60 のそれぞれが、どの要件とどのファイルとどのテストで守られているかを1枚の表にする。
対応が無いルールを「未実装」と明記し、抜けを見えるようにする。
逸脱表が「守らないもの」の台帳であるのに対し、この表は「守るもの」の台帳になる。

**対象要件** REQ-10-003
**前提タスク** T-DOCS-04, T-DOCS-05, T-DOCS-01
**成果物**
- `docs/rule-traceability.md`（新規）
- `tests/docs/traceability.test.ts`（新規）

**実装方針**
- 表の列を6つに固定する。`RULE-ID` / `ルール要旨（30字以内）` / `対応 REQ-ID` / `実装ファイル` / `テスト（パス::テスト名）` / `状態`。
- `状態` は `実装` と `未実装` の2値のみとする。`部分実装` を作らない。守り方が複数ファイルに分かれる場合は `実装ファイル` 列を ` / ` 区切りで並べる。
- `状態=未実装` の行は `実装ファイル` と `テスト` の両列を `-` にする。`対応 REQ-ID` は分かる範囲で書き、無ければ `-` とする。
- 行の並びは `docs/rules.json` の `rules` 配列の順に一致させる。ID 昇順へ並べ替えない。
- 逸脱によって「守らない」と決めたルール（RULE-32、RULE-33、RULE-34、RULE-42、RULE-57 など）は `状態=実装` とし、`テスト` 列に逸脱表と同じテストパスを書き、`ルール要旨` の末尾へ `（DEV-nn）` を付ける。逸脱行と食い違う記載を作らない。
- `tests/docs/traceability.test.ts` は次を assert する。`docs/rules.json` の60件それぞれに対応する行が1つずつあること、行の `RULE-ID` に重複が無いこと、`状態=実装` の行の `テスト` 列の各 `path` が実在すること、`状態` が2値のいずれかであること。
- `対応 REQ-ID` 列に書いた ID がすべて `docs/requirements.md` に存在することも同じテストで assert する。
- 表の前に「この表は手書きである。`docs/rules.json` へルールを追加したら同じコミットで行を足す」と1文だけ書く。生成物にしない。

**完了条件**
- [x] `docs/rule-traceability.md` の表の行数（ヘッダ2行を除く）が 60 である
- [x] `pnpm vitest --project unit run tests/docs` の `the traceability table` が緑になる
- [x] `状態=実装` の行が指すテストファイルがすべて実在し、`::` 以降のテスト名もその中に在る（テストで確認する）
- [x] 逸脱レジストリが RULE と結びつけている RULE-06 / 34 / 42 / 44 / 57 の行に `DEV-` を含む注記があり、取り下げ済みの DEV-07 を指す行が無い（RULE-32 と RULE-33 は逸脱を伴わないため注記を外した）
- [x] `docs/rules.json` へ61件目を追加するとテストが失敗する（`holds sixty rules across nine categories with no gaps` が件数を固定している）

---

### T-DOCS-15 Token 種類一覧と実装定数を突き合わせる

**概要**
共有 issuer と共有 JWKS の下では ID Token と Access Token と ID-JAG が同じ `iss` と JWKS に並ぶため、トークン種別の取り違えが検証の穴になる。
docs 05 §9 の8行を単一の定数表と1対1で対応させ、表に無い種別を新設できないようにする。
定数モジュール本体は契約パッケージ側で作り、本タスクは表と検査を持つ。

**対象要件** REQ-05-094
**前提タスク** T-DOCS-09
**成果物**
- `docs/05-identity.md`（§9 の表の列追加）
- `tests/docs/token-catalog.test.ts`（新規）

**実装方針**
- docs 05 §9 の表に `typ`、`DPoP`、`定数キー` の3列を追加し、既存の `Token` / `発行者` / `用途` / `備考` と合わせて7列にする。`備考` 列から `aud` の記述を切り出して `aud` 列を作り、8列にする。
- `定数キー` の値を次の8つに固定する。`human_id_token_login`、`human_access_token`、`human_id_token_xaa`、`human_refresh_token_xaa`、`agent_assertion`、`id_jag`、`native_resource_access_token`、`saas_access_token`。表の行順もこの順にする。
- `typ` 列の値を確定する。ログイン用 ID Token と XAA 用 ID Token は `JWT`、Human Access Token と Native Resource Access Token は `at+jwt`、Agent Assertion は `agent-assertion+jwt`、ID-JAG は `oauth-id-jag+jwt`、Human Refresh Token と SaaS Access Token は `-`（JWT ではないため）とする。
- `DPoP` 列は `必須` と `不要` の2値のみとする。`必須` になるのは Human Access Token、ID-JAG（`cnf.jkt` による束縛）、Native Resource Access Token の3行で、残りは `不要` とする。
- 表の直後に「表に無いトークン種別を新設しない。追加が要る場合は `packages/xaa-contracts/src/token-catalog.ts` の `TOKEN_CATALOG` と本表を同じコミットで更新する」と1文書く。
- `tests/docs/token-catalog.test.ts` は、`TOKEN_CATALOG` のキー集合が表の `定数キー` 列と一致すること、各エントリの `typ` と `dpop` が表の値と一致すること、`DPoP` 列が2値のみであることを assert する。
- `packages/xaa-contracts/src/token-catalog.ts` は契約パッケージ領域が作る。本タスクの時点で未実装なら、テストは skip せず import 失敗で赤にする。この扱いをテストファイル冒頭のコメントに書く。
- 各アプリの検証コードがこの定数を import していることの検査は、`rg -l "token-catalog" apps/*/src` の結果件数を assert する形で同じテストへ入れる。

**完了条件**
- [x] `docs/05-identity.md` の §9 の表が8列8行で、`定数キー` 列の値が実装方針に列挙した8つと一致する
- [x] `DPoP` 列に `必須` が3行、`不要` が5行ある
- [x] `pnpm vitest --project unit run packages/xaa-contracts/test/token-catalog.spec.ts` が緑になる（定数の所有者と同じパッケージに置いた）
- [x] 表に9行目を足すとテストが失敗する（`lists every constant key in the docs table, and nothing else` が集合一致を見る）

---

### T-DOCS-16 docs 検査を CI 必須ジョブへ束ねて README を更新する

**概要**
この領域が作った検査スクリプトを1つのコマンドと CI ワークフローへ束ね、常時実行されるようにする。
併せて、新しく増えた文書を `docs/README.md` の文書構成表と変更履歴へ載せる。
検査が CI に載っていない状態では、文書の整合は次の変更で崩れる。

**対象要件** REQ-10-002
**前提タスク** T-DOCS-01, T-DOCS-03, T-DOCS-04, T-DOCS-10, T-DOCS-11, T-DOCS-13, T-DOCS-14
**成果物**
- `package.json` の scripts に `check:docs` を追加
- `.github/workflows/docs.yml`（新規）
- `docs/README.md`（文書構成表と変更履歴の更新）

**実装方針**
- `check:docs` を `check:docs-links`、`check:glossary`、`check:deviations`、`check:requirements`、`check:legacy-names` の連続実行にする。いずれか1つでも非 0 なら全体を非 0 にする（`&&` で連結する）。
- `.github/workflows/docs.yml` に6つのジョブを置く。`docs:links`、`docs:glossary`、`docs:deviations`、`docs:requirements`、`docs:rules`（`pnpm gen:design-rules` の後に `git diff --exit-code docs/10-design-rules.md`）、`docs:diagrams`（`pnpm gen:diagrams` の後に `git diff --exit-code docs/diagrams/architecture.svg docs/diagrams/architecture.drawio`）。
- `docs:diagrams` ジョブでは Python 3 をセットアップし、cairosvg を導入しない。png を差分検査の対象にしない。
- `docs:glossary-strict` と `docs:deviations-strict` はワークフローに定義するが、`if: false` ではなく手動実行（`workflow_dispatch`）でのみ動く別ジョブとして置く。必須化の時期はそれぞれの文書冒頭に書いた条件に従う。
- テスト実行ジョブは別ワークフローに任せ、このワークフローに `vitest` を含めない。`tests/docs/*.test.ts` は通常のテストジョブで動く。
- `docs/README.md` の文書構成表へ5行追加する。`requirements.md`（全要件の索引）、`deviations.md`（ドラフトと設計ルールからの逸脱）、`rules.json`（設計ルールの正本）、`rule-traceability.md`（ルールと実装とテストの対応）、`glossary.md`（用語と実装識別子）。
- `docs/README.md` の「全体構成図」節の表に `generate.py` の再生成コマンドとして `pnpm gen:diagrams` を追記する。
- 変更履歴へ2行追記する。1行目に単一プロジェクト構成への書き換え、2行目に文書検査の CI 必須化。日付は `2026-08-30` を使う。

**完了条件**
- [x] `pnpm check:docs` が exit code 0 で終了する
- [x] `.github/workflows/ci.yml` の `docs` ジョブが links / glossary / deviations / requirements / legacy-names / rules の6検査を実行し、図の再生成差分を見る `diagrams` ジョブが別に定義されている（CI は単一の ci.yml に集約してある）
- [x] `docs/README.md` の文書構成表に上記5ファイルの行がある
- [x] `docs/glossary.md` の第1表から1行削除した状態で `pnpm check:docs` が非 0 で終了する（`fails when a term is dropped from the first table` が検査する）
- [x] `docs/10-design-rules.md` が rules.json とずれた状態で `docs` ジョブの再生成差分検査が失敗する（`notices when the generated markdown no longer matches the registry`）

---

### T-DOCS-17 Resource AS の失敗応答の記述を訂正する

**概要**
docs 08 は Resource AS の `/token` が 401 と `WWW-Authenticate` を返すと読める書き方をしているが、Token Endpoint の失敗応答は RFC 6749 §5.2 の 400 とエラーコードである。
401 と `WWW-Authenticate` を返すのは Resource API 側であり、両者を混ぜると実装者が Resource AS に誤った応答を書く。

**対象要件** REQ-08-044
**前提タスク** T-RES-06
**成果物**
- `docs/08-gcp-infrastructure.md`（当該記述の書き換え）

**実装方針**
- 当該記述を「Resource AS の `/token` は RFC 6749 §5.2 に従い 400 と `invalid_request` または `invalid_grant` を返す。401 と `WWW-Authenticate` を返すのは Resource API 側である」へ書き換える。
- T-RES-06 の本文にある「docs 領域へ起票する」の記述を「T-DOCS-17 が訂正する」へ差し替える。
- Resource AS 側の記述に 401 を残さない。

**完了条件**
- [x] `grep -n '401' docs/08-gcp-infrastructure.md` のヒットが Resource API を扱う節の中だけになる。
- [x] `grep -n 'WWW-Authenticate' docs/08-gcp-infrastructure.md` のヒットが Resource API を扱う節の中だけになる。
- [x] `grep -n 'docs 領域へ起票' tasks/done/05-resource-servers.md` が0件になる。

---

## このファイルで扱わない要件

| 要件ID | 内容 | 扱う領域 | 扱うタスクと成果物 |
|---|---|---|---|
| REQ-02-014 | Human IdP の `/token` で DPoP Proof の `jwk` から RFC 7638 Thumbprint を計算し、Access Token へ `cnf.jkt` を載せる | Human IdP | T-IDP-18。逸脱表の DEV-01 が対応する |
| REQ-05-017 | DPoP ユーティリティ（ES256 鍵生成、Proof 生成、Proof 検証、RFC 7638 Thumbprint、jti 重複排除）の自前実装 | 共有パッケージ | T-PKG-10。逸脱表の DEV-01 が対応する |

上の2件は本ファイルの検査対象には入る。
DEV-01 の行が指す `packages/xaa-crypto/src/dpop.ts` と `packages/xaa-crypto/test/dpop.spec.ts` の実在は T-DOCS-03 の strict モードが確認し、RULE-06 と RULE-44 の対応は T-DOCS-14 の表が持つ。
