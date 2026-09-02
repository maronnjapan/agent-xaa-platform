# 逸脱レジストリ

RULE-45 は、ドラフト仕様から外れる箇所について「外れていること」と「相互運用を期待しない範囲」を
文書に残すことを求めている。この表がその正本である。

判断の根拠は `tasks/00-decisions.md`、要件の索引は `requirements.md` にある。ここでは繰り返さない。

## 1. 逸脱一覧

| 逸脱ID | 逸脱した RULE / docs 節 | 代替実装（ファイルパス） | 固定するテスト（パス::テスト名） | 相互運用を期待しない範囲 |
|---|---|---|---|---|
| **DEV-01** | ドラフト ID-JAG は DPoP を要求しない。RULE-06 はこれを必須にする | `packages/xaa-crypto/src/dpop.ts` / `packages/xaa-crypto/src/dpop-middleware.ts` | `packages/xaa-crypto/test/dpop.spec.ts::rejects htu mismatch / iat out of window / replayed jti / ath mismatch / Bearer scheme` | ドラフトだけを実装した Resource AS は Proof を無視するため、この platform の Access Token を安全に扱えない |
| **DEV-02** | RFC 7523 の `private_key_jwt` ではなく独自の `agent-client-auth+jwt` を使う。docs 05 §3 | `apps/agent-op/src/middleware/client-assertion.ts` / `packages/xaa-contracts/src/client-assertion-type.ts` | `apps/agent-op/test/client-assertion.spec.ts::rejects the wrong typ` | maronn の client-auth は `client_secret_*` と `none` だけを扱う。標準の `private_key_jwt` を期待するクライアントはこの経路で認証できない |
| **DEV-03** | `actor_token` に独自の `typ`（`agent-assertion+jwt`）と `iss === sub` の制約を置く。docs 05 §5 | `apps/agent-runtime/src/tokens/agent-assertion.ts` / `apps/agent-op/src/idjag/actor-token-resolver.ts` | `apps/agent-runtime/test/execution-context.spec.ts::signs with a key that cannot be exported` | 一般的な RFC 8693 の `actor_token` を送るクライアントは `typ` の検査で落ちる |
| **DEV-04** | ID-JAG に `cnf.jkt` を載せる。ドラフトの ID-JAG に `cnf` は無い | `apps/agent-op/src/idjag/attach-cnf.ts` | `apps/agent-op/test/xaa-token.spec.ts::binds cnf.jkt to the DPoP proof key` | `cnf` を読まない Resource AS は鍵束縛を検証できず、盗まれた ID-JAG を受理してしまう |
| **DEV-05** | Firestore にドキュメント単位の IAM が無いため、責務分離をアプリ側のパスガードで担保する。RULE-42 | `packages/gcp/src/firestore-guard.ts` / `packages/gcp/src/access-matrix.json` | `packages/gcp/test/firestore-guard.spec.ts::denies cross-app path access` | データベース側の権限だけを見る監査は、この分離を確認できない |
| **DEV-06** | 受領側の `grant_type` はドラフトの `jwt-dpop` ではなく RFC 7523 の `jwt-bearer` を使う。docs 05 §7 | `packages/xaa-contracts/src/grant-types.ts` / `packages/xaa-resource-guard/src/redeem.ts` | `apps/agent-runtime/test/tool-executor.spec.ts::sends no client_secret and no basic auth` | `jwt-dpop` を送るドラフト実装は `unsupported_grant_type` になる |
| **DEV-07** | 取り下げ | - | - | - |
| **DEV-08** | maronn のライブラリを fork せず、生成物をコミットしてパッチマーカーで差分を管理する。DEC-ID-01 | `packages/xaa-contracts/src/library-surface.ts` / `generated-baseline/` | `apps/human-idp/test/discovery.spec.ts::has no registration_endpoint and no grant profile advertisement` | 上流の破壊的変更はマーカー外の差分として現れる。fork 前提の運用とは手順が異なる |
| **DEV-09** | direct プロファイルでは ID-JAG 発行を discovery で広告しない。docs 05 §7 | `apps/human-idp/src/oidc/routes/discovery.ts` | `apps/human-idp/test/discovery.spec.ts::advertises identity_chaining only in loadbalancer profile` | discovery を読んで発行可否を判断するクライアントは、direct プロファイルでこの機能を見つけられない |
| **DEV-10** | Human IdP と Resource AS の署名鍵を KMS の非対称鍵に置かず、封筒暗号でラップした鍵をアプリが持つ。REQ-05-032 | `apps/human-idp/src/keys/self-bootstrap.ts` / `apps/resource-docs-as/src/keys/self-bootstrap.ts` | `apps/human-idp/test/self-bootstrap.spec.ts::stores the private key wrapped, never in the clear` | KMS の非対称署名 API を通じた鍵の外部検証はできない。分離は kid で保つ |
| **DEV-11** | maronn の redeem 系が `cnf` を扱わないため、アプリ層で Proof of Possession を足す。RULE-44 | `packages/xaa-resource-guard/src/redeem.ts` / `apps/google-bridge/src/dpop/cnf-binding.ts` | `apps/google-bridge/test/bridge.spec.ts::tells a missing proof apart from a bad one` | ライブラリの redeem だけを使う実装は鍵束縛を検証しない |
| **DEV-12** | `aud` は要素一致で判定する。core の `buildAccessTokenAudience` が `${issuer}/userinfo` を常に足すため 2 要素以上になる | `packages/xaa-contracts/src/audience.ts` | `apps/lifecycle-manager/test/revoke-and-reprovision.spec.ts::returns 202 and starts cleanup for the owner` | `aud` を単一文字列として比較する実装は、この platform の Access Token を拒否する |
| **DEV-13** | Firestore Security Rules を作らず、ブラウザからの直接アクセス禁止をビルド成果物の検査で担保する。DEC-IAC-10 | `infra/tests/no-firestore-sdk-in-frontend.sh` / `scripts/checks/no-persistent-connection.sh` | `apps/automation-app/test/ui.spec.ts::carries no datastore SDK and holds no connection open` | Security Rules を前提にした監査は、この禁止を確認できない |
| **DEV-14** | 監査ログの dataset を別プロジェクトへ分けず、単一プロジェクト内で IAM により分離する。RULE-42 | `infra/envs/shared/audit.tf` / `infra/tests/forbidden-roles.sh` | `apps/security-detection/test/detection.spec.ts::has thirteen factors, matching the config exactly` | 同一プロジェクトの Owner は実行系と監査ログの両方へ届く。プロジェクト分離を前提とした保証は成立しない |
| **DEV-15** | `aud` を issuer 文字列から組み立てず、エンドポイントの URL から作る。direct プロファイルでは issuer と別ホストになるため | `apps/agent-runtime/src/tokens/client-assertion.ts` / `apps/agent-op/src/middleware/client-assertion.ts` | `apps/agent-runtime/test/execution-context.spec.ts::is not serializable` | issuer から `aud` を導出するクライアントは、direct プロファイルで認証に失敗する |

## 2. REQ-10-004 が挙げる7件との対応

| 要件が挙げる項目 | 対応する逸脱 |
|---|---|
| ドラフトが DPoP を要求しないこと | DEV-01 |
| `private_key_jwt` を使わないこと | DEV-02 |
| 受領側の `grant_type` | DEV-06 |
| ID-JAG の `cnf` claim | DEV-04 |
| `actor_token` の独自プロファイル | DEV-03 |
| 監査ログの dataset 分離 | DEV-14 |
| FULL_ISOLATION の実現方式 | 逸脱なし（DEC-IAC-07 により Dedicated OP を実行時に作り消す docs の記述どおりに戻したため） |

REQ-10-004 の本文にある「Agent Client Credential は `client_secret_basic`」は確定判断で
`client_assertion_jwt` へ置き換わっている。DEV-02 の記述が正である。

## 3. 逸脱ではないもの

次の3件は仕様の訂正であり、逸脱として起票しない。

- 受領側の `grant_type` を `jwt-dpop` と書いていた箇所は誤りで、`jwt-bearer` が正しい。DEV-06 は
  「ドラフトの記述から外れた」のではなく「ドラフトの誤りを直した」側の記録である。
- ID-JAG の `aud` を `urn:xaa:...` にする案は採用しなかった。`aud` は Resource AS の issuer（https URL）とする。
- docs 08 §9 が `actor_token` の署名鍵を KMS に置くと書いているのは誤りである。Agent Client Credential の
  秘密鍵は Execution のメモリにしか存在せず、KMS の署名権限は Runtime の Service Account に付与しない。

## 4. 逸脱を増やすときの手順

1. `逸脱ID` を末尾へ追番する。既存 ID の再利用と欠番を作らない。取り下げた DEV-07 の番号も再利用しない。
2. 残る4列をすべて埋める。空欄のある行は `docs:deviations` が落とす。
3. `固定するテスト` 列は `<パス>::<it の文字列>` の形で書き、テスト名は実装側と完全一致させる。
   複数ある場合は ` / ` で区切る。
4. `代替実装` 列には `apps/`、`packages/`、`infra/`、`e2e/` のいずれかで始まるパスを1つ以上書く。

`docs:deviations` は表の完全性だけを見る検査で、常時必須ジョブとする。
参照先の実在まで見る `docs:deviations-strict` は、全実装フェーズの完了時点で必須へ切り替える。
