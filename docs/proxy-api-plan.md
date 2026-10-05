# @nethernet-proxy/proxy 実装計画

状態: 初期実装済み。公開クラスは `NetherNetProxy`、raw中継は `Relay`（`TransportProxy` は互換alias）。
gatewayは同時生成・無効化・差し込みに対応。使い方は [proxy README](../packages/proxy/README.md) を参照。
不正順序・ID不一致・lifecycle decode失敗は診断してPlayer生成を断念し、転送を継続する。
実BDS + 実clientの検証、購読連動の追加機能、respawn等は未実施・未実装。
Node.js 26.xに統一。Login client dataの署名検証と、Join / Leave / PlayerでのSerenity `Readonly<Partial<ClientData>>` 公開を実装。
raw中継を保ち、通知のみLoginSuccessと検証完了を待つ。timeout・切断時の扱いはproxy READMEを参照。
client data取得はOnlineのみ。既定で必須（取得失敗時はエラーとして切断）、`requireClientData: false` なら取得失敗時に空オブジェクトを公開する。型引数は使わない。

## 目的と分担

`@nethernet-proxy/relay` のraw中継を基盤に、PlayerとMinecraftの意味を扱う高レベルAPIを提供する。
Login解析だけに用途を限定せず、今後packet操作、chat、表示、情報追跡などを追加できる構造にする。

```text
@nethernet-proxy/proxy
  ├─ @nethernet-proxy/relay    # 通信・中継・framing・Buffer hook・負荷制御
  ├─ @nethernet-proxy/emitter  # 型付き通知・同期キャンセル・購読変更通知
  └─ @serenityjs/protocol      # 必要なpacketだけdeserialize / serialize
```

- 公開APIの命名・使い方はMinecraft Script APIも参考にするが、互換性は目標にしない。
- 実装は主にSerenityJSを参考にする。ただしserver側の認証・world・Entity継承・spawn処理はコピーしない。
- 利用者に役立つsession、identity、取得済みの情報は積極的に公開する。JWT、秘密鍵、認証cache等を無差別にeventへ載せない。
- 高レベルAPIを利用しない通信に一般packetの解析コストを課さない。
- relayのtransport identityとゲームLogin由来のidentityを区別し、decode済みの情報を検証済みと見なさない。

## 最初の実装範囲

1. `packages/proxy` に `@nethernet-proxy/proxy` を作る。
2. `NetherNetProxy` はoptionsから `Relay` を生成し、高レベルの状態を管理する。既存Relayの差し込みは行わない。
3. 接続中の情報を内部に保持し、**SetLocalPlayerAsInitializedを確認した時に初めてPlayerを生成する**。
4. 参加・初回spawn・退出eventとPlayerの取得を実装する。
5. 後続メソッド用の共通packet送信・状態チェックを整えるが、chat等の機能一式は最初の実装に含めない。

初期案の利用イメージ:

```ts
import { NetherNetProxy } from '@nethernet-proxy/proxy';

const proxy = new NetherNetProxy(relayOptions);

proxy.on('playerJoin', (event) => {
  // Player生成前。session、identity、取得済み情報を利用できる。
  console.log(event.connectionId, event.identity);
});

proxy.on('playerSpawn', ({ player, initialSpawn }) => {
  // Playerは一覧に登録済み。初期実装はinitialSpawn: trueのみ。
  console.log(player.connectionId, initialSpawn);
});

proxy.on('playerLeave', ({ player, session, reason }) => {
  // spawn前ならplayerはundefined。生成済みなら閉じたPlayerも渡す。
  console.log(session.connectionId, player?.closed, reason);
});

proxy.players; // 初期化済みで接続中のPlayerだけを含むReadonlyMapのsnapshot
proxy.getPlayer(connectionId);
```

上記のpayloadは設計案。Script APIのplayerId/playerNameだけに制限しない。
識別の基本はconnectionIdとし、UUID/XUIDとは別物として扱う。再接続では新しいPlayerを生成する。

## ライフサイクル

```text
sessionOpen
  → 接続状態を生成。Playerは生成しない。
  → 必要なsession単位のhookを設定。
LoginSuccess（s2c）
  → BDSがゲームLoginを受理したことを観測。
  → playerJoinを1回だけ通知。
StartGame（s2c）
  → runtimeEntityIdと必要な初期情報を保持。
SetLocalPlayerAsInitialized（c2s）
  → 先行状態・対応するruntimeEntityIdを確認。
  → Player生成、一覧に登録。
  → playerSpawn({ initialSpawn: true })を1回だけ通知。
  → 初回参加の追跡用hookを解除。
sessionClose
  → 状態とhookを解放、Playerを閉じて一覧から除去。
  → Joinを通知済みならplayerLeaveを1回だけ通知。
```

- LoginSuccess前の接続失敗はplayerLeaveではなく既存のrelay eventで扱う。
- Join後、Spawn前に切断してもplayerLeaveを通知する。Playerを無理に作らない。
- 重複packet、重複切断、proxy停止、listenerからの切断でもイベントと終了処理を重複させない。
- Player生成前後に同じsession / 接続情報を引き継ぐ。
- event listenerの例外でも一覧除去・hook解除・transport終了を止めない。
- 追跡用packetの欠落・不正順序・runtimeEntityId不一致の方針を実装前に確定する。無条件にPlayerを生成しない。
- observerとして成立済みの処理を通知する場合はrelayのafter経路を使う。ただしafterは送信/queueへの受理であり、相手の処理完了保証ではない。
- server内部のspawn tickやclientの描画完了を保証しない。
- 初期実装で死亡後respawnを検知できるとは主張しない。Respawn等の状態機械は後続で追加する。
- 最初は1sessionにつき主playerを1つ扱う。subclient対応時は識別・event・packet contextを別途設計する。

## Playerの初期API

候補:

- `connectionId` / `session` / `closed`
- `identity`: 名前、XUID、UUID等の出所・検証状態を含む情報
- `runtimeEntityId`: 対応するStartGameと初期化通知から確定
- 必要な初期情報のreadonly snapshot
- `close(reason?)`: transportを閉じる操作

取得できない値を架空のUUIDやXUIDで埋めない。名前等の単独propertyを追加する場合もidentityの意味を明確にする。
StartGameの位置・gamemode等は初期snapshotであり、追跡しなければ現在値ではない。
退出後に保持されたPlayer参照は閉じた状態を示し、送信等は拒否する。

後続で `send` / `sendToServer` / `sendMessage` / title等のメソッドを追加する。
理由を画面へ表示する `disconnect` と、単なるtransport `close` は区別し、packet送信後の切断猶予・失敗も定義する。

## イベントとキャンセル

`@nethernet-proxy/emitter` を利用し、`on` / `once` / `off` を基本にする。
一部の介入eventだけ `before` / `onceBefore` / `offBefore` を許可し、`false` をキャンセルとする。

- 初期のplayerJoin / playerSpawn / playerLeaveは成立済みの観測通知として扱う。特に退出をキャンセルして後処理を止めない。
- 参加拒否が必要になったら、成立済みの通知とは別の `playerPreJoin` 等を追加し、キャンセルでsessionを切断する契約にする。
- chat等のpacketに関わるキャンセルはrelayの転送前経路に接続する。afterで通知済みの通信を巻き戻せるとは扱わない。
- emitterが返すbooleanは許可/拒否であり、通信を自動制御しない。呼び出し側が処理する。
- packetキャンセルは同期。通常通知のasync listenerは中継を待たせない。
- 将来、非同期admissionを追加する場合はpacket hookとは分け、deadline・待機予算・切断時の中止を定義する。
- 上位ProxyのonErrorを必ず設定する。観測失敗は診断して継続し、before失敗は拒否側に倒す。
- lifecycleの状態更新はon listener内ではなくライブラリ内部で行う。通知の有無に状態管理を依存させない。

## 購読に応じた処理の切り替え

イベント配送とBedrockのpacket依存関係は分離する。emitterはpacketを知らない。

```text
on / before / once の登録・解除・消費
  → onSubscriptionChange
  → 高レベル機能の需要を更新
  → 必要なsession・direction・channelのrelay hookを登録/解除
```

- Playerの生成・一覧維持に必要な初回追跡は内部需要として持ち、playerSpawn listenerが0でも省略しない。
- 追加event・追加情報追跡は購読に応じて有効化する。
- 複数eventが使うpacketは解析を共有し、参照数0になったときだけ解除する。
- beforeの需要がなければ転送を保持せず観測経路を使う。需要がなくなったらrawへ戻す。
- 登録変更時にhookを更新し、毎frameで全eventの登録一覧を走査しない。
- 最後のonce消費で需要が0になっても、実行中batchのsnapshotは維持する。
- 過去の未解析情報は途中からの購読で復元できない。基本情報として常時取得するものと追加追跡を区別する。
- 圧縮batch中のpacket IDを知るにも解凍が必要。必要packetだけ解凍できる、という性能保証はしない。
- 任意packetのbody定義に依存しないraw中継を維持し、packet bodyは必要なものだけdeserializeする。

## relayに必要な拡張

session単位の購読を実装済み。以下はその要件。
全session共通の初回追跡を常設せず、参加済みsessionをrawへ戻す。

- sessionごとのbefore / after需要とsnapshotを管理する。
- 全session共通hookとsession固有hookの実行順序・重複・解除を定義する。
- direction / 必要ならchannelで対象を限定する。
- packet ID、direction、channelをbody解析前の判断に使える範囲で使う。圧縮batchの制約は残る。
- session終了時に固有hookを必ず解放する。
- 参加完了sessionは、他sessionが参加中でも初回追跡のdecode経路に残さない。
- 登録変更は次batchから反映し、beforeの後付けで既に転送したbatchを保留へ切り替えない。

## 検証と実装順序

1. 独立emitterを実装・検証。
2. session単位のrelay hookと既存raw経路の回帰test。
3. 上位package、内部接続状態、Player、3つのlifecycle event。
4. packet再生成をしない観測と、初期化後のraw復帰を検証。
5. 実BDS + 実clientでJoin / Spawn / Leaveの順序・情報を確認。
6. その後、必要なメソッド・キャンセル可能event・respawn対応を追加。

test項目:

- 通常参加、Join前切断、Join後Spawn前切断、Spawn後切断。
- 重複LoginSuccess / Initialized / Close、不正順序、runtimeEntityId不一致。
- sessionごとの独立性、再接続、proxy停止、listenerからの切断。
- イベント時点の一覧・Player状態と、退出後の操作拒否。
- listener例外、通知Promise rejection、同期キャンセル、不正なbeforeの返り値。
- once後に次listenerが飛ばないこと、元callbackで解除できること。
- 発火中の登録変更、最後の購読解除、複数機能の需要共有。
- 購読なし・観測のみ・beforeありのCPU、allocation、転送遅延、raw復帰。

syntheticなno-op送信benchmarkはネットワーク性能・本番容量の証明としない。
WebRTC backend、圧縮、GC、同時接続、world通信を含む実負荷で別途評価する。

## 参考

- [SerenityJS Player](https://github.com/SerenityJS/serenity/blob/main/packages/core/src/entity/player/player.ts)
- [SerenityJS LoginHandler](https://github.com/SerenityJS/serenity/blob/main/packages/core/src/handlers/login.ts)
- [SerenityJS Initialized handler](https://github.com/SerenityJS/serenity/blob/main/packages/core/src/handlers/set-local-player-as-initialized.ts)
- [Script API PlayerJoinAfterEvent](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/playerjoinafterevent)
- [Script API PlayerSpawnAfterEvent](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/playerspawnafterevent)

最新upstreamの実装を参考にしつつ、使用する `@serenityjs/protocol` のversionとの整合を確認する。
