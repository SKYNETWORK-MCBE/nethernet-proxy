# nethernet-proxy

BedrockのNetherNet通信を中継するTypeScript / ESMライブラリのworkspaceです。

サポートするバージョン: 1.26.50

## Packages

| Package                                                  | 内容                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`@nethernet-proxy/relay`](packages/relay/README.md)     | raw frame中継、session管理、Bufferベースのpacket hook・送信、HTTP signaling |
| [`@nethernet-proxy/emitter`](packages/emitter/README.md) | 型付きイベント、同期キャンセル、購読状況の変更通知                          |
| [`@nethernet-proxy/proxy`](packages/proxy/README.md)     | `NetherNetProxy`、gatewayの組み立て、PlayerとJoin / Spawn / Leave           |

```sh
pnpm add @nethernet-proxy/proxy
```

使い方・設定は [proxyのREADME](packages/proxy/README.md) と [relayのREADME](packages/relay/README.md)、内部の処理契約は
[実装ドキュメント](packages/relay/docs/implementation.md)を参照してください。

上位ライブラリの設計と後続範囲は [API実装計画](docs/proxy-api-plan.md)にまとめています。

## 設定ガイド：BDSの前段にproxyを置いて公開する

Proxyはclientとの接続を自分で終端し、BDSへは別の接続を張ります。
clientが直接つなぐのはproxyだけなので、公開IP・port転送の設定はproxy側にまとめ、BDSはLAN内に閉じます。

```text
client ──HTTP(TCP 19134)──▶ proxy gateway
client ──WebRTC(UDP 40000-40010)──▶ NAT ──▶ proxy (UDP 30000-30010) ──LAN──▶ BDS (TCP 19132 / UDP 30100-30110)
```

以下の例では公開IPを `203.0.113.10`、proxyとBDSを動かすホストのLAN IPを `192.168.1.20` とします。

### 1. BDS（server.properties）

```properties
transport=nethernet
server-port=19132
# ローカルのport範囲だけを指定する。公開IPの対応（ip:external:internal）は書かない
server-udp-ports=30100-30110
```

BDSはLANのhost候補を広告するので、proxyはLAN内で直接BDSへつながります。
BDSの範囲はproxyの `internal` と重ならないようにしてください。

### 2. Proxy

`publicUdp` はBDSの `server-udp-ports=203.0.113.10:40000-40010:30000-30010,203.0.113.10:41000:31000` に相当します。

```ts
import { NetherNetProxy, proxyServerIdentity, authenticateTransport } from '@nethernet-proxy/proxy';

const serverUrl = 'http://127.0.0.1:19132';
const status = await (await fetch(new URL('/v1/join', serverUrl))).json();
const proxy = new NetherNetProxy({
  serverUrl,
  clientSideIdentity: await proxyServerIdentity(),
  serverSideIdentity: await authenticateTransport(String(status.version)),
  publicUdp: {
    address: '203.0.113.10', // clientへ広告する公開IP
    ports: [
      // external: 公開port（ルーター側）、internal: proxyがbindするport。長さを揃える
      { external: [40000, 40010], internal: [30000, 30010] },
      { external: 41000, internal: 31000 }, // 1portだけの対応も可
    ],
  },
  maxSessions: 12, // internalのport数の合計以下にする
});
await proxy.listen(19134, '0.0.0.0');
```

- 各sessionは `ports` を先頭から探し、空いているinternal portを1つだけ使います。
- `internal` を省略すると `external` と同じ番号でbindします（ルーター側でport番号を変えない場合）。
- internalの範囲同士は重ねられません。
- 既定では全インターフェース（`0.0.0.0`）でbindし、host候補には最初に見つかったLANのIPv4アドレスを載せます。
  載せるLAN IPを固定したい場合は `interfaceAddress: '192.168.1.20'` を指定します（そのIPでbindします）。
- internal portが埋まっている間の接続は、answerを返す前にConnectErrorですぐ失敗します。
- `publicUdp` 使用時はclient側に `iceServers` でSTUNを指定しないでください。
  候補収集は1接続ずつ順に行うため、STUNの応答待ちが他の接続を待たせます。

### 3. ルーター・ファイアウォール

| 転送元（公開）  | 転送先                     | 用途                      |
| --------------- | -------------------------- | ------------------------- |
| TCP 19134       | `192.168.1.20:19134`       | proxyのHTTP signaling     |
| UDP 40000-40010 | `192.168.1.20:30000-30010` | proxyのWebRTC（1対1対応） |
| UDP 41000       | `192.168.1.20:31000`       | proxyのWebRTC             |

BDSのport（TCP 19132 / UDP 30100-30110）は公開しません。clientがproxyを迂回してBDSへ直接つなぐことを防げます。

### 4. 確認

clientへ返るanswerに、公開IPの候補が入っていれば設定は反映されています。

```text
a=candidate:... 1 udp 2116026367 192.168.1.20 30000 typ host ...
a=candidate:public40000 1 udp 2116026367 203.0.113.10 40000 typ host ...
```

## 開発

Node.js 26.x とpnpm 12.9.1を使用します。開発runtimeは `devEngines.runtime` で26.10.0に固定しています。

```sh
pnpm install
pnpm build
pnpm check
pnpm lint
pnpm test
```

`pnpm dev` はrootの `main.ts` を実行します。
relay単体の起動例は `packages/relay/main.ts`。`pnpm --filter @nethernet-proxy/relay dev` で実行します。

## License

[MIT](LICENSE)。SerenityJS由来の部分の著作権表示・ライセンスは [proxyのthird-party notices](packages/proxy/THIRD_PARTY_NOTICES.md) に記載しています。
