# サイトの使い方

デプロイした Automation App を画面から操作して、Agent を1つ作り、動かし、止めるまでの手順である。
デプロイ自体は[README](../README.md)にある。
同じ内容を短くしたものが、ログイン後の画面の「使い方」（`/guide`）にある。

## 1. 前提

必要なものは3つである。

- Automation App の URL：`scripts/deploy-gcp-guide.sh` が最後に表示する。あとから調べるなら `terraform -chdir=infra/envs/demo output -json service_urls` である。
- ログイン情報：`testuser` または `otheruser`。パスワードはどちらも `password` である。この2人は `apps/human-idp/src/oidc/store.ts` が持つ固定ユーザーで、追加はできない。
- ログインユーザーへの Human Permission：`scripts/deploy-gcp-guide.sh` が `document.read`、`document.write`、`finance.payment.read`、`finance.payment.approve` を付ける。

Human Permission が空のままだと、ログインはできても権限決定がすべて却下になり、Agent を1つも作れない。
`GRANT_DEMO_PERMISSIONS=0` でデプロイした場合や、あとから増減させたい場合は次のコマンドで付け外しする。

```bash
GOOGLE_CLOUD_PROJECT=<project-id> STORE_MODE=gcp PUBSUB_MODE=gcp \
  pnpm perm:set <testuser|otheruser> <capability_id> <grant|revoke>
```

## 2. 全体の流れ

| 段階 | 画面 | 押すもの | そこで決まること |
|---|---|---|---|
| 1 | `/` | 「下書きを保存する」 | 何をさせたいか（Work Definition） |
| 2 | `/` | 「この内容で確定する」 | 作業内容が固まる。以後は書き換えられない |
| 3 | `/` | 「必要な権限を調べる」 | その作業に許可される操作と隔離のレベル（Agent Definition） |
| 4 | `/` | 「この権限で承認する」 | 提示された権限への同意 |
| 5 | `/` | 「この内容で Agent を作る」 | Agent が作られ、動き出す |
| 6 | `/agents/{agent_id}` | 「指示を追加する」「この Agent を止める」 | 実行中の Agent への追加指示と停止 |
| 7 | `/activity` | Task をクリック | 終わった処理の再生 |

段階1から5までは、ログイン後に開く1枚の画面（`/`）の中で上から下へ進む。

## 3. ログインする

Automation App の URL を開くと Human IdP のログイン画面へ飛ぶ。
ユーザー名とパスワードを入れると、認可要求が続けて5回走る。
最初の1回で ID Token を取り、残りの4回で Automation App、Authorization Platform、Agent Provisioner、Lifecycle Manager それぞれ宛のアクセストークンを取る。
パスワードを聞かれるのは最初の1回だけで、画面が何度か切り替わるのはこのためである。

戻ってきた先が「自動化をつくる」の画面である。

## 4. 作業を書いて確定する

「1. 自動化したい作業を書く」に、目的、説明、手順、確認したいこと、注意点、動かしておきたい時間を書く。
手順と確認したいことと注意点は、1行に1つ書く。
動かしておきたい時間は最大24時間で、これを超える値は保存の時点で断られる。

何を書くか決まっていないときは、画面の上にある「自動化できそうな作業を探す」に期間を入れる。
その期間に記録されている作業から、自動化できそうなものを挙げる。

**この画面に権限を書く欄は無い**。
何を許可するかは書いた作業内容から決まるもので、利用者が先に指定するものではない（[03. 権限決定](./03-authorization.md)）。

保存すると「2. 内容を確定し、提示された権限を承認する」に並ぶ。
直したいところがあれば「書き直してもらう」に文章で伝えると、書き直した案が同じ場所に反映される。
これは作業内容の文面だけを書き換えるもので、確定させる操作ではない。

「この内容で確定する」を押すと作業内容が固まる。
確定した作業内容は書き換えられない。

## 5. 権限を確認して承認する

確定した作業に「必要な権限を調べる」が出る。
押すと Authorization Platform が、書かれた作業内容と、ログインユーザーが持つ Human Permission、組織のポリシー、リスクのポリシーを突き合わせ、許可する操作と隔離のレベルを決める。
結果は Agent Definition として画面に出る。

許可される操作は、決まったままの文字列で並ぶ。
Automation App はこの文字列の意味を持たず、言い換えも並べ替えもしない（[10. 設計ルール](./10-design-rules.md) の RULE-07）。

「この権限で承認する」を押すまで Agent は作られない。
承認した時点で、提示された操作の一覧がハッシュとして記録される。

続けて「この内容で Agent を作る」を押すと Agent Provisioner が Agent を作り、画面はその Agent の画面へ移る。
承認から作成までの間に必要な権限が変わっていた場合、作成は断られる。
その場合は提示され直した内容を読み、承認からやり直す。

外部 SaaS を使う自動化を `enable_google_bridge=true` で動かしている場合は、ここで同意画面の URL へ飛ぶ。
同意すると元の画面へ戻り、続きが進む。

## 6. 動いている Agent を操作する

作られた Agent は「3. 動き出した Agent」に並ぶ。
名前をクリックすると Agent の画面（`/agents/{agent_id}`）へ移る。

この画面でできることは3つである。

- 状況確認：いまの状態、残り時間、実行中の Task、使った Tool とその結果が出る。実行中のものを含む今の断面である。
- 追加指示：「指示を追加する」で、動いている Agent に伝えることを足す。承認した権限の外の操作は、指示しても Tool Executor が実行を断る。
- 停止：「この Agent を止める」で即座に止まる。止めた Agent は元に戻せない。同じ作業をさせるには、作業を書くところからやり直す。

権限を増やす操作はどこにも無い。
作られた Agent の権限はその生涯にわたって変わらないためで、足りなければ新しい Agent を作る（[02. §5](./02-automation-design.md#5-実行中agentの操作)）。

Agent は希望した時間を過ぎると自動で消える。
上限は24時間である（[07. Lifecycle](./07-lifecycle.md)）。

## 7. 実行の様子を見る

`/activity` は、ログイン、権限の決定、Agent の作成、Tool の呼び出し、停止までを時系列で見せる。
Task をクリックすると、そのとき実際に起きた呼び出しの経路がアニメーションで再生される。
遮断された処理は、経路が宛先の手前で止まる動きで示される。

再生できるのは終わった Task だけである。
動いている最中のものは名前だけが出る。
途中経過を見たいときは Agent の画面の状況確認を使う（[11. アクティビティタイムライン](./11-activity-timeline.md)）。

画面は自分の記録だけを見せる。
他の利用者のログインや Agent は、同じ画面のどこにも出ない。

### 7.1 遮断を再現して見る

権限の外の操作が止まる様子を、実際に危険な操作をせずに見せたい場合、記録済みの台本を自分のタイムラインへ流し込める。
画面にはボタンが無いため、ログイン済みのブラウザから次を実行する。

```javascript
await fetch('/api/demo/replay', {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ scenario_id: 'dpop-replay' }),
});
```

`scenario_id` に指定できるのは `dpop-replay`、`cross-agent-isolation`、`delegation-mismatch`、`signing-key-misuse` の4つである。
流し込んだ Task には「デモ実行（模擬）」の印が常に付き、実際に起きたこととは区別される。
Agent の状態は変わらず、Security Detection にも何も届かない。

## 8. うまくいかないとき

| 症状 | 原因 | すること |
|---|---|---|
| 「必要な権限を調べる」の結果が空、または却下ばかり | ログインユーザーの Human Permission が空 | §1 の `pnpm perm:set` で付ける |
| 「この内容で Agent を作る」が断られる | 承認したあとに必要な権限が変わった | 提示され直した内容を読み、承認からやり直す |
| Agent が Tool の実行を断られた | 承認した権限の外の操作だった | 作業内容を書き直し、新しい Agent を作る |
| タイムラインに何も出ない | 終わった Task が無い | Agent の画面の状況確認で今の状態を見る |
| 画面がログイン画面へ戻る | セッションが切れた | もう一度ログインする |

## 9. 片付ける

Automation App と Human IdP はインターネットへ公開され、ログイン情報は固定である。
確認が終わったら破棄する。

```bash
PROJECT_ID=<project-id> make demo-destroy   # アプリだけを消す
PROJECT_ID=<project-id> make destroy-all    # プロジェクト以外を全部消す
```

作り直すときは `scripts/deploy-gcp-guide.sh all` を実行する。
