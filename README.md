# Agent XAA Platform

自律型 AI エージェントに、人間から委譲された権限の範囲内だけで社内 API と外部 SaaS を使わせるための認証認可基盤である。
設計は [docs/](./docs/README.md)、GCP の構成と運用は [infra/README.md](./infra/README.md) にある。

## 初めて動かす

GCP、Terraform、プログラミングの知識は要らない。
必要なのは、Google アカウント、クレジットカード（請求先アカウントの作成に使う。初回は無料トライアルのクレジットが付く）、パソコン1台である。
macOS と Linux はターミナルで、Windows は [WSL2](https://learn.microsoft.com/ja-jp/windows/wsl/install) の Ubuntu の中で実行する。

1. Git を入れる（macOS は `xcode-select --install`、Ubuntu は `sudo apt-get install -y git`）。
2. このリポジトリを取得して移動する。

   ```bash
   git clone https://github.com/maronnjapan/agent-xaa-platform.git
   cd agent-xaa-platform
   ```

3. ガイドスクリプトを実行する。
   `PROJECT_ID` には世界中で一意な名前を付ける（6〜30文字の小文字、数字、ハイフン）。

   ```bash
   PROJECT_ID=agent-xaa-<好きな文字列> scripts/deploy-gcp-guide.sh all
   ```

スクリプトは最初に必要なツール（gcloud、Terraform、Node.js、Docker、jq）を確認し、足りないものをまとめて、インストール手順の URL 付きで表示する。
入れ終わったら同じコマンドをもう一度実行する。

一度始めたら、途中で入力を求めて止まることはない。
未ログインならブラウザが開いて Google ログインを求め、そこから先は最後まで自動で進む。
請求先アカウントは、このアカウントから見えているものを自動で選ぶ。
足りない設定がある場合は、GCP を変更する前に、足りないものを全部まとめて出して終わる。
言われたとおりに指定して同じコマンドを実行し直せばよい。

人が手で作るしかないもの（請求先アカウントそのもの、Google OAuth client）が無い場合だけは、作り方のページを表示して終わる。

初回の所要時間は 30〜60 分である。
費用は放置で月額約 $0.5、1日動かして $1.1〜1.5 の見込みである（[tasks/README.md](./tasks/README.md) の DEC-COST-01）。

終わると、ブラウザで開く URL とログイン情報（`testuser` / `password`）が表示される。
その画面で自動化したい内容を書き、提示された Agent Definition を承認すると、エージェントが実行を始める。

## 実行内容だけを確認する

GCP を変更せずに、実行するコマンドの一覧だけを見る。

```bash
PROJECT_ID=<project-id> BILLING_ACCOUNT_ID=<XXXXXX-XXXXXX-XXXXXX> scripts/deploy-gcp-guide.sh all --dry-run
```

## 片付ける

Automation App と Human IdP はインターネットへ公開され、ログイン情報は固定である。
検証が終わったら破棄する。

```bash
PROJECT_ID=<project-id> make demo-destroy          # アプリだけを消す。作り直しは deploy-gcp-guide.sh all
PROJECT_ID=<project-id> make destroy-all           # プロジェクト以外を全部消す
```

## 開発する

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:e2e
```

Node.js 22 と pnpm を使う。
main へのマージは `.github/workflows/deploy.yml` が配備する（[infra/README.md](./infra/README.md)）。
