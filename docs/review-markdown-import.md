# review-markdown-cli から ToDo を取り込む

[review-markdown-cli](https://github.com/maronnjapan/review-markdown-cli) でレビュー中に「やると決めた」タスクを、この基盤の ToDo（下書き）として登録するコマンドである。
実体は [apps/review-markdown-import](../apps/review-markdown-import) で、`pnpm review:import` から動かす。

## 1. どちら側に何があるか

連携のためのコードは、すべてこちら側にある。

review-markdown-cli は、この基盤のことを何も知らない。
登録先の URL もアクセストークンも持たず、この基盤へ要求を送る口も持たない。
あちらがすることは、これまでどおりレビューの記録を書き出すことだけである。

このコマンドがすることは、その書き出されたファイルを読むことだけである。
読むのは `<レビュー対象>/.review/<文書のパス>.tasks.json` で、これは review-markdown-cli が自分の README に形を公開している出力である。
書き込みはしない。
何を登録したかの記録は、このコマンド自身のファイルへ書く（[4章](#4-二重に登録しない)）。

境目をこちら側へ寄せてあるのは、`/external/todos` の項目・断り方・トークンの決まりが、いずれもこの基盤の都合だからである。
`title` だけを必須にしたのも、`agent:operate` スコープを求めるのも、この基盤が決めたことであり、レビューの道具が抱える理由がない。
項目を増やせばこのコマンドが直り、レビューの道具は関係しない。

ただし、レビュアーが書く項目の**形**は、あちらがこちらへ揃えている。
優先度の `high` / `normal` / `low` と、完了条件・手順・補足（`done_criteria` / `steps` / `notes`）は、名前も意味も上限も同じである。
読み替え表を挟まないのは、表が「片方にだけ足された値」を黙って既定値へ落とすからである。
揃える前に書かれた記録の `now` / `next` / `later` は、読むときだけ `high` / `normal` / `low` として読む。

## 2. 用意する

必要なのは、Human IdP が発行したこのアプリ宛のアクセストークンである。
`automation-app` クライアントで認可コードフローを行い、`agent:operate` スコープを要求して得る（[user-guide 7.5](./user-guide.md#75-他のツールから-todo-を登録する)）。

トークンは環境変数で渡す。
コマンドライン引数の口は用意していない。
引数に書いたトークンはシェルの履歴に残り、共用のマシンでは `ps` にも出るからである。

```bash
export AUTOMATION_APP_URL=http://127.0.0.1:8080
export AUTOMATION_APP_ACCESS_TOKEN=<アクセストークン>
```

## 3. 動かす

レビューしたディレクトリを渡す。
`.review/` はリポジトリに1つで、レビュー対象がその下の階層でも構わない（`docs/` を渡せば、上の `.review/` を探して読む）。

```bash
pnpm build
pnpm review:import ~/work/design-docs
```

```
registered docs/plan.md#t3 as wd-8f2c: 請求書の様式を確認する
registered docs/plan.md#t7 as wd-91a0: 経理へ確認する項目をまとめる
registered 2, already registered 5
```

送る前に中身だけを見るときは `--dry-run` を付ける。
何も送らないので、トークンも要らない。

```bash
pnpm review:import ~/work/design-docs --dry-run
```

| オプション | 中身 |
|---|---|
| `--url <url>` | 登録先の Automation App。省略すると `AUTOMATION_APP_URL` を使う |
| `--state <path>` | 登録した記録の置き場。省略すると `<レビュー対象>/.review/.automation-app-import.json` |
| `--dry-run` | 登録せず、登録するはずのものを並べる |
| `-h`, `--help` | 使い方を出す |

## 4. 二重に登録しない

登録すると、どのタスクをどの ToDo にしたかを台帳へ書く。
置き場は既定で `<レビュー対象>/.review/.automation-app-import.json` で、`--state` で移せる。
同じディレクトリへ何度実行しても、前に登録したタスクは飛ばして、増えた分だけを登録する。

台帳はこのコマンドのファイルであり、review-markdown-cli は読まない。
消せば次の実行で全部登録し直す。
`--url` で別の Automation App を指せば、そちらへは登録し直す。
一方に作った下書きは、もう一方には無いからである。

## 5. 何が登録され、何が登録されないか

登録するのは、レビュアーが「やると決めた」（`plan.commitment` が `committed`）タスクのうち、まだ完了・見送りになっていないものだけである。
AI が起こしただけで、まだ誰も読んでいない候補は登録しない。

| ToDo の項目 | 元になるもの |
|---|---|
| `title` | タスクの題名 |
| `description` | タスクの詳細 |
| `context` | 元の文書のパス、担当、引用、レビュアーが書いた参考知識のうち、書かれているものだけ |
| `priority` | タスクの優先度。同じ3値なので、そのまま送る |
| `due_on` | レビュアーが決めた期限。決めていなければ送らない |
| `done_criteria` | レビュアー（完了条件はレビューAIが書くこともある）が書いた完了条件。書かれていなければ空 |
| `steps`、`notes` | レビュアーが書いた手順と補足。書かれていなければ空 |
| `requested_lifetime_minutes` | 送らない。実行してよい時間はこのアプリの既定に従う |

1件が断られても、残りは続ける。
断られた件は理由とともに1行ずつ出て、1件でもあれば終了コードは1になる。

| 出るもの | すること |
|---|---|
| `the access token is not valid any more` | トークンを取り直して `AUTOMATION_APP_ACCESS_TOKEN` に入れ直す |
| `the access token does not carry the agent:operate scope` | `agent:operate` を要求してトークンを取り直す |
| `title is longer than 200 characters` など | そのタスクを review-markdown-cli 側で短くする |
| `steps has more than 50 items` など | 記録を手で直したときだけ出る。review-markdown-cli 側で直す |
| `could not reach <url>` | `AUTOMATION_APP_URL` と、アプリが動いているかを確かめる |

## 6. できないこと

登録できるのは下書き（`DRAFT`）までである。
確定も、権限の承認も、Agent の作成もしない。
どれも人がその内容を読んでから押す操作であり（RULE-08）、`/external/todos` にその口が無い。
つまり、このコマンドとトークンだけでは Agent は動き出さない。
続きは Automation App の画面で行う（[サイトの使い方](./user-guide.md)）。
