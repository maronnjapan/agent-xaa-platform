# GCP 前提実測

> (a) は 2026-09-05 に、spike ではなく稼働中の demo 環境（`agent-xaa-platform` / `asia-northeast1`）で実測した。
> automation-app から authorization への `POST /api/work-requests` が 404 になる事象の切り分けとして測ったため、
> 判定の根拠は spike の `caller /probe` ではなく本番同型の経路そのものである。
> (b)(c)(d) は未実測のまま。

| 判定項目 | 実測コマンド | 出力の要点 | 判定 | 影響する DEC |
|---|---|---|---|---|
| (a) VPCなしの INTERNAL_ONLY への3経路 | 下記 | Cloud Run → Cloud Run のみ 404。Scheduler OIDC と Pub/Sub push は到達 | **一部不可** | DEC-IAC-14, DEC-IAC-15 |
| (b) Cloud Run URL の決定性 | observed_uri と expected_uri の完全一致 | 未実測（`run.googleapis.com/urls` には `https://<service>-<project_number>.<region>.run.app` が含まれていた） | 未実測 | DEC-IAC-05 |
| (c) allUsers invoker | caller_url /healthz | `/healthz` は Google Frontend が横取りし、コンテナへ届かない。health ルートを `/livez` へ移して解いた | **測れない経路がある** | DEC-IAC-14, DEC-IAC-15 |
| (d) standalone project の Deny Policy | gcloud iam policies get | 未実測 | 未実測 | DEC-IAC-11 |

## (a) の測り方と読み

VPC を1つも作っていない状態（`google_compute_network` / `google_vpc_access_connector` は0件）で、
`ingress = INGRESS_TRAFFIC_INTERNAL_ONLY` の Cloud Run Service へ3経路を通した。

| 経路 | 観測 | 到達 |
|---|---|---|
| Cloud Run Service → Cloud Run Service（ID Token 付き、`run.invoker` 付与済み） | automation-app が `POST {authorization}/api/work-requests` を呼ぶと 404。Google Frontend の HTML が返り、**authorization 側には request log が1件も残らない** | 不可 |
| Cloud Scheduler → Cloud Run Service（OIDC） | `POST {lifecycle}/internal/tick` が 200 を返し続けている | 可 |
| Pub/Sub push → Cloud Run Service（OIDC） | `POST {authorization}/internal/events/human-permission-changed` が 204 | 可 |

同じ呼び出しを、authorization の ingress だけ `all` にして繰り返すと 200 と decision 本文が返った。
`roles/run.invoker` の付与も ID Token も呼び出し側は変えていないので、
落としているのは IAM ではなく ingress である。

読み: **ingress の判定は IAM より手前にある。**
VPC を持たない Cloud Run Service の外向き通信はインターネットへ出るため、
同一プロジェクトの Cloud Run Service からの呼び出しでも INTERNAL_ONLY には内部として届かない。
404 は「呼ぶ権利がない」ではなく「そのホストにサービスが無い」という応答なので、
呼び出し側からは設定ミスと区別が付かない。

## (c) `/healthz` はコンテナまで届かない

(a) を測るついでに気付いた。`*.run.app` への `GET /healthz` は、公開されている
automation-app でも Google Frontend が 404 を返し、コンテナのルーティングまで届かない。

| 要求 | 応答 | どこが返したか |
|---|---|---|
| `GET {automation-app}/` | 302 → `/login` | アプリ（`server: Google Frontend` 付き） |
| `GET {automation-app}/nonexistent` | 404 `404 Not Found`（text/plain） | アプリ（Hono の既定） |
| `GET {automation-app}/healthz` | 404 Google の HTML エラーページ（`referrer-policy: no-referrer`、`server` ヘッダ無し） | Google Frontend |
| `GET {automation-app}/healthz/`、`/HEALTHZ` | 404 `404 Not Found`（text/plain） | アプリ |
| `GET {automation-app}/%68ealthz`、`//healthz` | Google の HTML エラーページ | Google Frontend（正規化後に一致する） |

`Authorization` を付けても `X-Serverless-Authorization` を付けても同じで、
authorization のように ingress=ALL にしたサービスでも `/` は 403 を返すのに
`/healthz` だけ 404 になる。したがって全アプリが持つ `app.get('/healthz')` は
`*.run.app` 経由では到達不能である。

影響: `infra/tests/reachability.sh` は全エッジを `/healthz` で叩き 200 か 403 を期待する。
どのケースも 404 になるため `make verify` は通らず、`make demo-apply` がそれを連鎖して
呼ぶので deploy workflow も止まる。

採ったのは health ルートを移す案である。横取りされるのは `/healthz` だけで、
`/livez` `/readyz` `/health` `/_ah/health` はいずれもアプリの 404（text/plain、
`server: Google Frontend` 付き）が返る。全アプリの health ルートを `/livez` へ移し、
probe もそこへ向けた。

probe だけを別パスへ向ける案は採らなかった。`/healthz` に届かないのは reachability だけの
問題ではなく、`apps/provisioner/src/runtime.ts` の `healthCheck` も Dedicated OP の
`*.run.app` URL へ `GET /healthz` を投げており、この経路では常に 404 を受け取る。
probe を変えてもこちらは直らない。

`apps/agent-op/src/routes/healthz.ts` はファイル名を変えていない。
`tasks/done/04-agent-op.md` の成果物一覧が名指すパスであり、変えると監査の対象が動く。

## 起票

`tasks/done/01-infra.md` の T-IAC-01 が定めたとおり、(a) 不可を DEC-IAC-14 の見直しとして起票した。
VPC 導入や INTERNAL_LOAD_BALANCER へは寄らず（制約5 の低コストと `public-surface.sh` の検査4）、
**公開集合（`allUsers` に invoker を与える集合）と ingress を開ける集合を分ける**方向で解いた。
反映先は `infra/envs/demo/locals-services.tf` の `run_called_services` / `ingress_all_services`、
`apps/provisioner/src/runtime.ts` の Dedicated OP、および `tasks/00-decisions.md` の DEC-IAC-14。
