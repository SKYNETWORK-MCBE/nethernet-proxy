# 検証記録

検証日：2026-10-04。Node.js 24.21.0、nethernet 1.1.2、nethernet-gateway 0.2.0、Werift。
PoCの記録は今回の実装の実測とは区別する。

## 自動テスト

`pnpm test`：69件成功。`pnpm check` / `pnpm lint` / `pnpm build` も成功。

- PoC由来：token署名/issuer/audience/期限、SDP fingerprint binding、JWK/SPKI、拒否時の非割当。
- operator identity署名、P-384制限、cache/鍵の再利用・permission・壊れた鍵の拒否。
- early channel捕捉、Reliable/Unreliable、元Buffer / ArrayBuffer storageの再利用。
- deflate / Snappy / 非圧縮、batch分割、サイズ・VarUInt・fragment数上限。
- before / after順序・隔離、置換・破棄・全破棄、Serenity TextPacketとsubclient bits。
- selectorだけでは経路を変えない、進行中batchのsnapshot、解除後のraw復帰。
- handlerなしの圧縮追跡、後からのhook・注入、注入再帰防止、fragment割り込み防止。
- queue/保持frameの共通制限、転送失敗時のafter抑止、未完了fragment timeout。
- HTTP policy、切断・timeout・gateway終了・proxy終了時の交渉中止と遅延検証の非割当。
- **実WebRTC**：2player同時接続、2つのserver接続、client/server両channelのbyte列・message境界。
- 実WebRTC：方向別hook、deflate / Snappy設定のsession分離、注入packetの往復。
- 片方のsessionのみ切断、他方の通信継続、再接続、UDPWrap数の検証前baselineへの復帰。
- server側HTTP失敗を繰り返した場合の、交渉途中のclient/server peer・socket解放。

WebRTC integrationの接続相手はsynthetic echo endpoint、token authorityはtest用RSA/JWKS。
外部Minecraft authorityと実BDSは次節で別に確認した。

## 公式BDS

同梱 **BDS 1.26.52.3 / protocol 2193 / online-mode=true / transport=nethernet** を使用。
元のserver.propertiesは変更せず、一時ディレクトリのコピーで別HTTPポートを使用した。
PoCの認証cacheも一時コピーを使用。検証後に起動したBDSを停止した。

`pnpm probe`：未認証offerは `connecterror:37` で拒否。
`pnpm probe --auth`：Minecraftの正規transport token、既定SDP verifier、自己署名operator identity、
TransportGateway経由で **2 session** を同時接続。両方でReliableのNetworkSettings（ID143）を受信。
1 sessionをcloseして残りが1 sessionになることを確認し、最後に全接続をcloseした。

このprobeの確認範囲は、transport認証、WebRTC接続、NetworkSettings受信、sessionの分離・終了まで。
実クライアントでのプレイ、実機Unreliable操作、Snappy BDS、NAT/TURN、多人数・高負荷運用は別途検証が必要。

## 性能

`pnpm bench`：16packet（body各128byte）、deflate batch、DataChannel message約2103byte。
1000batch warmup後に各20000batchを同期処理し、DataChannel sendはno-opに置換。
同じBufferを繰り返し使用するsyntheticなcore測定で、**ネットワーク速度・RTTではない**。

当環境での一回の参考値：

| 経路                       | µs / batch | 元frame再利用 |
| -------------------------- | ---------: | ------------: |
| handlerなし                |       0.35 | 20000 / 20000 |
| afterのみ                  |      13.20 | 20000 / 20000 |
| before、変更なし           |       9.03 | 20000 / 20000 |
| before、同内容Bufferで置換 |      53.34 |     0 / 20000 |

CPU/JIT/GC・実行順の影響がある。afterとbeforeの小さな差を一般化しない。
確認したのは、raw経路では一般packetの解析をせず、観測/変更なしは元frameを使い、
Buffer置換時だけ再encodeするという分離である。

```sh
BENCH_ITERATIONS=100000 pnpm bench
```

本番相当の評価は同じClient操作、world、描画距離、人数で複数回行う必要がある。
hookの同期処理時間、WebRTC backend、event loop、BDSとのCPU競合、GCを含めて別途計測する。
