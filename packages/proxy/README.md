# @nethernet-proxy/proxy

`NetherNetProxy` は `Relay` とHTTP signaling gatewayを組み立て、ゲーム参加・初回spawn・退出を追跡します。
Node.js 26.x / TypeScript・ESM向けです。

```sh
pnpm add @nethernet-proxy/proxy
```

```ts
import { NetherNetProxy, proxyServerIdentity, authenticateTransport } from '@nethernet-proxy/proxy';

const serverUrl = 'http://127.0.0.1:19132';
const response = await fetch(new URL('/v1/join', serverUrl));
if (!response.ok) throw new Error('server_status_failed');
const status = await response.json();
const proxy = new NetherNetProxy({
  serverUrl,
  clientSideIdentity: await proxyServerIdentity(),
  serverSideIdentity: await authenticateTransport(String(status.version)),
  gateway: {
    configure(gateway) {
      // terminal join handlerより先にHTTP policy middlewareを登録できる。
      gateway.use(async (context, next) => next());
    },
  },
});

proxy.on('playerJoin', ({ connectionId, identity, clientData }) => {
  // BDSのLoginSuccessを観測し、client dataの検証も完了。Playerはまだ生成しない。
  console.log(connectionId, identity.name, identity.xuid);
  console.log(clientData.DeviceModel, clientData.DeviceOS);
});
proxy.on('playerSpawn', ({ player, initialSpawn }) => {
  // Initializedを観測。Playerは既に一覧へ登録済み。
  console.log(player.name, player.xuid, player.pfid, player.runtimeEntityId, initialSpawn);
});
proxy.on('playerLeave', ({ connectionId, player, reason }) => {
  // Join後・Spawn前の退出ならplayerはundefined。生成済みならclosed。
  console.log(connectionId, player?.closed, reason);
});

await proxy.listen(19134, '127.0.0.1');
// 終了時：gatewayとrelayの両方を閉じる。
// await proxy.close()
```

## Relay / gatewayの設定

`RelayOptions` を直接渡すと、proxyがRelayを生成します。既存Relayの差し込みには対応しません。
rawの上限・transport設定・packet hookは [relayのAPI](../relay/README.md) と同じです。

```ts
import { NetherNetProxy, TransportGateway } from '@nethernet-proxy/proxy';

const proxy = new NetherNetProxy({
  ...relayOptions,
  gateway: (relay) =>
    new TransportGateway(relay, {
      configure: (gateway) => {
        /* HTTP middlewareを先に登録 */
      },
    }),
});

// 別の選択肢（同時には作らない）：
// new NetherNetProxy({ ...relayOptions, gateway: false })
// new NetherNetProxy({ ...relayOptions, gateway: (relay) => new TransportGateway(relay, gatewayOptions) })
```

- gateway省略で既定の `TransportGateway` を生成。constructorは待受を開始せず、`listen(port, host?)` で開始します。
- `gateway: false` はHTTP gatewayなし。別途 `proxy.relay` を使って入口を用意できます。
- 既存gatewayは同じrelayに接続されている必要があります。factoryも同期です。
- `close()` は差し込んだものも含めてgateway・relayを閉じます。gateway単独の停止は `proxy.gateway?.close()`。
- 認証・operator鍵の取得は非同期なのでconstructorの外で行います。秘密鍵・tokenの自動取得や更新は追加していません。

## Playerとevent

`on` / `once` / `off` は型付きemitterです。初期eventはすべて観測通知で、キャンセルできません。
通常listenerのPromiseは待たず、例外・rejectionは固定コードの診断へ送ります。
`sessionOpen` / `sessionReady` / `sessionClose` / `packetError` / `signalingRejected` も転送します。

`playerJoin` / `playerLeave` は `connectionId / session / identity / protocol? / clientData` を持ちます。
Leaveには `player? / reason`、Spawnには `player / initialSpawn: true` があります。
Join前の接続失敗にLeaveは発火しません。

- `proxy.players`: 初期化済み・接続中Playerの `ReadonlyMap` snapshot。
- `proxy.getPlayer(connectionId)`: Player取得。再接続では新しいPlayerです。
- `player.connectionId / session / closed / identity / runtimeEntityId / protocol? / clientData`。
- `player.xuid / name / pfid`: `identity` の対応fieldを返すgetter。取得できない値は `undefined`。
- `player.initialState`: entityId、runtimeEntityId、gamemode、position、dimension、pitch、yawのreadonly snapshot。現在値の追跡ではありません。
- `player.close(reason?)`: transport終了。画面に理由を表示するdisconnectとは異なります。
- `player.send(buffer, options?)` / `sendToServer(buffer, options?)`: serialize済み単一packetを送信。閉じたPlayerは拒否します。
- `proxy.packetHandler(...)` / `proxy.relay` / `session.packetHandler(...)`: raw hookへのアクセス。

`identity` はLogin由来の `name? / xuid? / pfid? / uuid? / verified` を持つフラットなreadonly snapshotです。Join / Leave / Playerで共有します。
`pfid` はLogin tokenの `mid`（PlayFab ID）です。online tokenとclient JWTの検証が成功した場合は `verified: true`、decodeのみ・offlineの場合は `false` です。
値がなければ省略し、UUID/XUIDを生成しません。JWT・鍵そのものはeventへ載せません。
signaling identityがある場合は、認証済みLogin tokenのXUIDと照合します。不一致は `identity_xuid_mismatch` として `requireClientData: false` でも切断し、未通知のJoin / Spawn / Leaveは発火しません。
照合はclient JWT検証より前に行います。通知timeout後に不一致が判明した場合も、同じ接続が生きていれば切断します。既にJoinを通知していればLeaveを通知します。
名前やPlayFab IDは比較せずLogin側を採用します。未検証LoginのXUIDがsignalingと一致しても `verified: true` にしません。
signaling情報がない場合は照合を省略し、`verified` はLoginの署名検証結果を表します。詳細なsignaling情報は `player.session.verifiedSignaling` で取得できます。

## Loginのclient data

`clientData` はSerenityの `ClientData` を使う `Readonly<Partial<ClientData>>` です。`ClientData` はこのpackageからもtype exportします。
`playerJoin`、`playerLeave`、`Player` で同じオブジェクトを共有し、device情報だけでなく `SkinData`、`SkinGeometryData`、`PersonaPieces` 等も保持します。
検証済みJWTのpayloadを選別せず公開します。追加claimも保持しますが、型定義はSerenityのままで、proxy独自の `source` / `verified` は付加しません。認証状態は `identity.verified` を参照してください。
JWT文字列や署名検証用の鍵は公開しません。端末識別情報やskinを含むため、client data全体のログ出力・外部公開は避けてください。
`Readonly` と `Object.freeze()` はトップレベルのみです。nested array/objectは書き換えないでください。

`requireClientData` は既定で `true` です。取得できなければtransportを切断し、client dataなしのPlayer/eventは公開しません。
`false` を明示した場合のみ、取得失敗時も空オブジェクト `{}` で接続を継続します。成功時は取得したpayloadをそのまま公開します。

```ts
const required = new NetherNetProxy(relayOptions);
required.on('playerJoin', ({ clientData }) => console.log(clientData.DeviceOS));

const optional = new NetherNetProxy({ ...relayOptions, requireClientData: false });
optional.on('playerJoin', ({ clientData }) => console.log(clientData.DeviceOS));
```

型引数やoption連動の型分岐はありません。`clientData` 自体は常にobjectで、取得できないfieldは `undefined` です。

- c2s Loginのafter経路で検証を開始。PoCと同じく、online tokenを認証し、その `cpk` で `Authentication.verify()` によりclient JWTを検証します。
- online token認証は既存の `nethernet-gateway/minecraft` のissuer / audience / RS256 / JWKS検証を再利用します。
- client data取得は `AuthenticationType.Online` のみ対応します。offline / legacy Certificate / SubClientは取得失敗として扱います。
- `Authentication.verify<ClientData>()` の結果をそのまま公開します。proxy独自のfield検査・欠損値の補完は行いません。
- 署名検証は端末・OS等の自己申告の真偽を保証するものではありません。
- raw中継は非同期検証を待ちません。`playerJoin` 通知はLoginSuccessと検証完了の両方を待ち、Initializedが先に来てもJoin → Spawnの順を維持します。
- Initialized観測後は追跡hookを解除します。検証待ちの間も、そのsessionは他のhookがなければ次batchからrawへ戻ります。
- 検証失敗・timeout・同時検証数超過・LoginなしのLoginSuccessでは固定コードの診断を出し、必須モードはエラーとして切断します。`requireClientData: false` の場合は `clientData: {}` で継続します。
- 検証待ちのまま切断した場合、必須モードはJoin / Spawn / Leaveを通知せず、`sessionClose` のみ通知します。`false` の場合はLoginSuccessを観測済みなら空のclient dataでJoin → Leaveを通知します。
- 切断・停止・timeout後のmetadataは破棄し、再接続や閉じたPlayerへ反映しません。timeout後のXUID不一致だけは、生存中の同じ接続を切断します。共有JWKS取得自体は中止しません。

`NetherNetProxyOptions` の `loginTimeoutMs` は通知の最大検証待ち時間（既定5000 ms）、`maxPendingLogins` は同時検証数（既定8）です。
timeout / 切断後も実際の検証処理が終了するまで同時検証枠を保持します。JWTの署名検証に必要なNode 26のAPIを使用し、NubのAPI補完には依存しません。

## 初回追跡の方針・制限

Reliable・主player（subclient bitsが0）のLogin / PlayStatus / StartGame / Initializedだけを、session固有のafter hookで観測します。
一般packetのbodyは解析せず、転送packetを再生成しません。圧縮batchの解凍は必要です。
StartGameは `src/protocol/start-game.ts` のSerenity形式の定義でdimensionまでの先頭だけを読み、block palette・NBT・telemetry等の後半はデコードしません。
Initialized観測後は初回hookを解除し、他のhookがなければ**次batchからそのsessionだけraw経路へ復帰**します。

- LoginSuccess → StartGame → runtimeEntityIdが一致したInitializedでのみPlayerを生成。
- LoginSuccess / 同じruntimeEntityIdのStartGame / Initialized / Closeの重複はeventを増やしません。
- 不正順序・異なるruntimeEntityId・lifecycle packetのdecode失敗は `player_tracking_error` を診断し、その接続でのPlayer生成を断念します。raw転送・BDS接続は継続します。
- Login identityのdecode失敗だけならclient dataの検証を試みます。client dataの取得にも失敗した場合、必須モードは切断します。
- packetが欠落した場合は後続状態を捏造しません。Join後に切断すればPlayerなしのLeaveを通知します。
- afterは送信/queue受理の観測で、相手の処理完了・描画完了を保証しません。
- 初期実装は初回spawnのみ。respawn、chat/title、高レベルのbefore介入、追加情報の購読連動は未実装です。

SerenityJS upstreamのLogin/Initialized handlerと [PoC CLI](https://github.com/tutinoko2048/nethernet-proxy-poc/blob/main/src/cli.ts) のclient data検証を参考にしています。world・Entity生成やBDSに代わる参加認証は行いません。
packet定義は `@serenityjs/protocol` **0.8.21** に固定。実BDS + 実clientの動作確認・本番性能測定は別途必要です。

## License

このpackageは [MIT](LICENSE) です。SerenityJS由来の実装には `Copyright (c) 2024 SerenityJS` が適用されます。
取り込み元・変更点とupstreamのライセンス全文は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。再配布時はこのnoticeも保持してください。
