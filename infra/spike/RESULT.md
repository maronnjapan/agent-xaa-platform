# GCP 前提実測

> この表は terraform apply 後に実測値で更新する。現時点では未実測であり、P1 へ進むためのゲートは閉じている。

| 判定項目 | 実測コマンド | 出力の要点 | 判定 | 影響する DEC |
|---|---|---|---|---|
| (a) VPCなしの INTERNAL_ONLY への3経路 | caller /probe、Scheduler run、Pub/Sub publish | 未実測 | 未実測 | DEC-IAC-14, DEC-IAC-15 |
| (b) Cloud Run URL の決定性 | observed_uri と expected_uri の完全一致 | 未実測（observed と expected を引用予定） | 未実測 | DEC-IAC-05 |
| (c) allUsers invoker | caller_url /healthz | 未実測 | 未実測 | DEC-IAC-14 |
| (d) standalone project の Deny Policy | gcloud iam policies get | 未実測 | 未実測 | DEC-IAC-11 |
