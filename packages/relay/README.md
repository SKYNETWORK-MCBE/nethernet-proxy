# @nethernet-proxy/relay

BedrockのNetherNet通信を終端・中継するTypeScript / ESMライブラリです。
packetの購読・書き換え・破棄・送信と、接続ごとのsession管理を提供します。

```text
Client ← WebRTC / NetherNet → Proxy ← WebRTC / NetherNet → BDS
         HTTP signalingはTransportGatewayが別経路で処理
```

server側のtransport identityにはProxy自身のidentityを使用します。
DTLSはClient–Proxy、Proxy–BDSの各区間を保護します。

## 構成と実装の分担

独自実装の中心は、**DataChannel上のNetherNet frame中継とBedrock packet処理、session管理**です。

```text
HTTP signaling（game trafficとは別経路）
  Client → TransportGateway → ClientEndpoint
           nethernet-gateway   nethernetのServerを拡張
  serverConnector → BDS HTTP API
  nethernetのClient + 独自のHTTP signaling adapter

Game traffic（前後に独立したWebRTC接続）
  Client ⇄ [nethernet / WebRTC backend]
                  ⇅ raw DataChannel frame
           [独自のsession / framing / packet hook]
                  ⇅ raw DataChannel frame
           [nethernet / WebRTC backend] ⇄ BDS
```

### このライブラリで独自実装している部分

| 部分                  | 担当ファイルと処理                                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proxy / session       | `src/proxy.ts` / `src/session.ts`：clientごとのBDS接続生成、双方向中継、接続待ちqueue、backpressure、上限・timeout、event、終了処理                                                                                     |
| Packet hook           | `src/hooks.ts`：packet ID / directionによる購読、before / after、登録snapshot。書き換え・破棄・注入の実行はsessionが担当                                                                                                |
| Framing               | `src/framing.ts`：NetherNet fragmentの分割・再構成、Bedrock batch / VarUInt / packet header、subclient bits保持、圧縮方式の選択。NetworkSettingsの最小限の解析で圧縮設定を追跡                                          |
| Transport adapter     | `src/transport.ts` / `src/raw-channels.ts`：接続生成時の捕捉、Reliable / Unreliableの生frame受信、認証・接続数制限、BDS向けHTTP signaling                                                                               |
| HTTPとの接続          | `src/gateway.ts`：joinをclient endpointへ接続し、HTTP切断・timeout・停止を交渉中止へ反映                                                                                                                                |
| Identity / 認証の補助 | `src/sdp-verifier.ts`：検証済みSDPのdigest・期限・同時検証数を管理。`src/server-identity.ts`：operator鍵、自己署名token、client向けSDP署名。`src/auth.ts`：BDS接続用token取得の組み立て。storage類：鍵・認証cacheの保存 |

channelとmessage境界を保つため、adapterがDataChannelの受信handlerを差し替え、独自にframeを処理してDataChannelへ直接送信します。
接続生成の捕捉には `nethernet` 1.1.2の内部構造にも依存しています。
hook未登録・圧縮交渉済みなら、packetを解凍・解析せず元frameを転送します。

### 外部ライブラリ・BDSに任せている部分

| 依存先                              | 担当                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `nethernet`                         | Server / Client / Connectionの生成、SDP offer / answer処理、DataChannel生成・受付、接続状態の管理。BDS向けofferのidentity署名も担当            |
| WebRTC backend（`werift` / `wrtc`） | `nethernet` 経由で使用。ICE候補収集、STUN / TURN、UDP socket、DTLS、SCTP、DataChannelの通信・順序・再送。既定は `werift`                       |
| `nethernet-gateway`                 | HTTP signalingのrouting・middleware・upstream転送、SDP identity / fingerprint署名検証、Minecraft tokenのissuer / audience / JWKS検証           |
| `prismarine-auth`                   | Proxy用アカウントのMicrosoft / Xbox / Minecraft認証。取得したMinecraft tokenからmultiplayer session tokenを得るHTTP処理は `src/auth.ts` が担当 |
| Node.js `node:zlib` / `snappyjs`    | Deflate / Snappyの圧縮・解凍アルゴリズム。batch構造・圧縮header・適用タイミングは独自実装                                                      |
| Node.js `node:crypto`               | 鍵生成、hash、署名などの暗号処理。identity token / SDP署名の形式は独自に組み立て                                                               |
| BDS                                 | game protocolの処理、world・game logic                                                                                                         |

UDP socketとICE候補はWebRTC backendが管理します。現在使用する `nethernet` APIはUDPポート範囲指定を公開していません。
BDSの `server-udp-ports` はBDS側のUDP割り当て、gatewayの `listen(port, host)` はProxyのHTTP待受を設定します。

## インストール

Node.js 26.x とNetherNet対応の接続先serverが必要です。

```sh
pnpm add @nethernet-proxy/relay
```

## 基本的な使い方

workspaceのrelay単体の起動例は `main.ts` です。rootから以下で起動できます。

```sh
pnpm --filter @nethernet-proxy/relay dev
```

`packages/relay/` 内では `pnpm dev`。`BDS_URL` / `PROXY_PORT` / `PROXY_WEBRTC_BACKEND` で設定できます。
identity helperの既定保存先は実行directoryの `cache/` です。

`Relay` がpacket中継を、`TransportGateway` がHTTP signalingを扱います。
旧名 `TransportProxy` / `ProxyOptions` / `ProxyEvents` は互換aliasとして残しています。
Playerと参加・退出event、gatewayの同時生成が必要なら [上位package](../proxy/README.md) を使ってください。
packet bodyのdecode / encodeはrelayの対象外です。必要なら任意のprotocolライブラリを利用側で使ってください。

```ts
import {
  Relay,
  TransportGateway,
  proxyServerIdentity,
  authenticateTransport,
} from '@nethernet-proxy/relay';

const TEXT_PACKET_ID = 9;

const serverUrl = 'http://127.0.0.1:19132';
const response = await fetch(new URL('/v1/join', serverUrl));
const status = await response.json();
const proxy = new Relay({
  serverUrl,
  clientSideIdentity: await proxyServerIdentity(),
  serverSideIdentity: await authenticateTransport(String(status.version)),
});

proxy.on('sessionOpen', (session) => {
  // 受信経路設定済み。WebRTC / 圧縮交渉の完了ではない。
  console.log('open', session.connectionId);
});
proxy.on('sessionReady', (session) => {
  // 前後のReliable / Unreliableがopen。圧縮交渉はまだの場合がある。
});
proxy.on('sessionClose', (session, reason) => console.log('close', session.connectionId, reason));

const text = proxy.packetHandler(TEXT_PACKET_ID, { direction: 'c2s' });
const stopBefore = text.before((buffer) => {
  // header + bodyの単一packet。何も返さなければ原本のまま転送、nullを返すと破棄、Bufferを返すと置換。
  if (buffer.length > 1024) return null;
});
const stopAfter = text.after((buffer, context) => {
  // 転送後の単一packet。UDP/batch/compression/fragment headerは含まない。
  console.log(context.connectionId, context.direction, buffer.length);
});

const gateway = new TransportGateway(proxy);
await gateway.listen(19134, '127.0.0.1');
```

アプリケーションの終了時に購読を解除し、gatewayとProxyを閉じます。

```ts
stopBefore();
stopAfter();
await gateway.close();
await proxy.close();
```

## Packet hook

`packetHandler(id, { direction?, channel? })` はselectorだけを作ります。
`before()` / `after()` で実際に登録し、何度呼んでも安全な解除関数を返します。
IDは0〜1023の整数。direction省略は両方向、channel省略は両channelです。
relayでの登録は全session共通、`session.packetHandler(...)` での登録はそのsessionだけです。
同じpacketの各phaseでは全session共通hook → session固有hookの順で実行します。
同じcallbackの登録もそれぞれ実行され、返された解除関数で独立して解除できます。
session終了時に固有hookを解放し、最後の解除後は次batchからそのsessionのraw経路へ戻ります。

| direction内の登録 | 動作                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| なし              | 元frameを即send / queue。圧縮交渉後はhook用reassembly・decode・copyなし |
| afterのみ         | 元frameを即send / queueした後、完成batchをdecodeして観測                |
| beforeあり        | batch完成まで保持、decodeとbeforeの後に転送                             |

- callbackは**同期**。async関数は登録時に拒否し、返されたPromiseも待ちません。
- beforeは登録順。`undefined` / 返り値なし = 元packet維持、`Buffer` = 置換、`null` = 破棄。
- 渡したBufferの変更だけでは置換しません。各callbackに独立したBufferを渡します。
- 変更なしのbatchは元frameを再利用。置換・破棄時だけbatch全体を再encodeします。
- BufferはVarUInt packet header + body。元のsubclient bitsを置換Bufferへ付け直します。
- 置換Bufferは元packetと同じID・有効なbody形式で返してください。
- contextは不変で `connectionId / networkId / id / direction / channel` を持ちます。
- 登録・解除は**各direction・channelの次のbatch**から反映します。callback中の変更も同様。
  進行中batchは開始時のsnapshotを使うため、解除済みcallbackがそのbatchでは実行され得ます。
- afterは最終fragmentを含む全出力をDataChannelまたは転送queueへ受理した後に通知。
  相手への到着保証ではなく、queueの後日のflush失敗で通知を取り消しません。
- 破棄したpacketにはafterを呼びません。全破棄なら出力しません。
- beforeの例外・無効な返り値・decode失敗は当該sessionを切断。
  afterの例外・decode失敗は `packetError` 通知だけで、元frameの転送を維持します。

## Packet送信

圧縮交渉後、handler未登録でも利用可能です。

```ts
session.client.send(packet.serialize()); // s2c、既定Reliable
session.server.send(packet.serialize(), { channel: 'unreliable' }); // c2s

// connectionId指定も同じ処理：
proxy.sendToClient(session.connectionId, packet.serialize());
proxy.sendToServer(session.connectionId, packet.serialize());
```

- 単一packetをbatch化・圧縮・fragment化します。入力Bufferの後日の変更はqueueへ影響しません。
- 戻り値は `'sent'` / `'queued'`。sentも受信確認ではありません。
- 同じdirection・channelの中継fragment列やbefore/after処理へ割り込ませず、batchの後ろに注入します。
- 注入packetにはbefore / afterを適用しません。callbackからの送信で再帰しません。
- 圧縮設定未取得なら `compression_unknown`、切断後は `session_closed`。
- queueとbackpressure制限は中継・保持batch・注入で共通です。

## Eventとsession

| event               | 引数と発火条件                                                            |
| ------------------- | ------------------------------------------------------------------------- |
| `sessionOpen`       | `(session)`：client接続生成と受信経路設定後、server接続開始前             |
| `sessionReady`      | `(session)`：前後の計4channelがopenになったとき、1回だけ                  |
| `sessionClose`      | `(session, reason)`：論理的切断・queue解放時、1回だけ                     |
| `packetError`       | `(session, reason, direction, channel)`：hook / framing診断               |
| `signalingRejected` | `(connectionId, reason)`：認証 / admission拒否。session未生成の場合もある |

通常eventにはEventEmitter形式の `on()` / `once()` / `off()`、packet購読には `packetHandler()` を使います。
`proxy.sessions` は `ReadonlyMap<string, Session>` のsnapshotです。
sessionは `connectionId / networkId / verifiedSignaling / client / server / ready / closed / close()` を持ちます。
`session.close()` / `proxy.close()` はPromiseを返し、WebRTCのcloseとserver接続用discovery socketの終了を待ちます。
`sessionClose` 自体はその待機より先に発火します。片方の切断は他sessionやhook登録へ影響しません。

## 設定

`client` は元Client、`server` は接続先serverです。
`clientSideIdentity` はClientへ返すanswerに署名するProxyのoperator identityです。
`serverSideIdentity` もProxy自身のidentityで、BDSへ送るofferに使用します。

`RelayOptions` にはclient側の入口用にnethernetの `ServerOptions` も渡せます。

| option                             | 既定                                                             |
| ---------------------------------- | ---------------------------------------------------------------- |
| `serverUrl` / `clientSideIdentity` | 必須                                                             |
| `serverSideIdentity`               | 未指定。online BDSでは正規identityが必要                         |
| `verifyOffer`                      | nethernet-gatewayのMinecraft token / SDP fingerprint検証         |
| `webrtcBackend`                    | `werift`（前後共通）                                             |
| `serverOptions`                    | response / inactivity timeout各20秒。server側ICE設定等を指定可能 |
| `maxSessions`                      | 128（検証中の予約を含む）                                        |
| `maxPendingOffers`                 | 8（検証〜client接続確立待ち）                                    |
| `offerTimeoutMs`                   | 20000（client側検証/SDP生成、server側HTTP）                      |
| `acceptTimeoutMs`                  | 20000（clientのWebRTC接続待ち）                                  |
| `maxQueueBytes`                    | 8 MiB（保持/待機 + 観測時点のDataChannel bufferedAmount）        |
| `maxQueueMessages`                 | 4096（保持/待機frame数）                                         |
| `maxPayloadBytes`                  | 8 MiB（受信payload、解凍後batch、再encode）                      |
| `fragmentSize`                     | 10000 byte（payload部分。出力は最大256fragment）                 |
| `fragmentTimeoutMs`                | 20000                                                            |
| `log`                              | 出力なし。JWT・SDP・body全文は診断に含めない                     |

上限超過・send失敗は当該sessionを切断します。Reliableのfragment不整合/timeoutも切断します。
Unreliableの欠落・順序変更では観測/保持batchを破棄して診断し、Reliable接続は維持します。
Unreliableの到達・順序は保証されません。

`TransportGateway` は `offerTimeoutMs`（既定25秒）、`configure`、policy用 `verifyClientToken` を受け付けます。
HTTP切断・timeout・gateway停止は進行中交渉を中止します。gatewayを閉じるだけでは確立済みsessionは閉じません。

### Identity helper

独自に管理する `nethernet` の `Identity` を設定へ直接渡すほか、以下のhelperを利用できます。

| API                              | 用途                                                                        |
| -------------------------------- | --------------------------------------------------------------------------- |
| `proxyServerIdentity()`          | Proxyのoperator鍵を生成・再利用し、client側の署名用identityを取得           |
| `loadServerIdentity(path)`       | 指定したPEM鍵からclient側の署名用identityを取得                             |
| `renewServerIdentity(identity)`  | operator identityの自己署名tokenを更新                                      |
| `authenticateTransport(version)` | 指定したBedrock versionで、server接続用アカウントのtransport identityを取得 |

helperの既定保存先は作業directoryの `cache/` です。鍵と認証情報は機密情報として管理してください。

## 利用上の注意

- NetworkSettings等の制御packetの変更・破棄は前後の圧縮状態を食い違わせ得るため、互換性を保証しません。
- 長期運用では利用側で新規接続用のserver側tokenを更新してください。
- server側SDPの受け入れは、接続先BDSへの信頼を前提とします。
- 公開運用にはHTTPS、HTTP policy/rate limit、ICE/UDP到達性、必要に応じてTURNが別途必要です。
  HTTP middlewareはgame trafficを通りません。
- サイズ制限はありますが、hook・zlibは同期です。重いcallbackや大量decodeはevent loopを占有します。
