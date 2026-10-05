# 実装上の決定

実装の構成と内部の処理契約をまとめる。

## 分離

- `proxy.ts`：認証済みclient接続、sessionごとのserver接続生成、通常event、非同期終了。
- `session.ts`：4stream（direction × channel）、queue、圧縮設定、順序制御。
- `hooks.ts`：方向別登録数とID別callback一覧のcopy-on-write snapshot。
- `framing.ts`：bounded VarUInt、batch、圧縮、fragment、subclient保持。
- `gateway.ts`：HTTP signalingのmiddlewareと中止処理。
- `transport.ts` / `raw-channels.ts`：nethernet 1.1.2のearly connection/channel adapter。
- `sdp-verifier.ts` / `server-identity.ts` / `auth*.ts` / `cache-storage.ts`：SDP検証、identity署名、transport認証、鍵・認証cacheの保存。

Proxyを主語に、元Clientへつながる接続を `clientConnection`、BDSへつながる接続を
`serverConnection` と呼ぶ。client側の受信入口は `ClientEndpoint` / `proxy.clientEndpoint`、
server側へ接続するSDK instanceは `serverConnector`。
SDKのクラス名は `NetherNetClient` / `NetherNetServer` とaliasする。
設定は `serverUrl` / `clientSideIdentity` / `serverSideIdentity` / `serverOptions`。
両identityはProxy自身の鍵・認証情報である。

## ビルド

Vite+内蔵のtsdownを `vp pack` で実行し、`packages/relay/vite.config.ts` の `pack` でlibraryのentryを指定する。
ESM、型定義、source mapを `dist/` に出力し、依存packageは外部依存として維持する。
TypeScriptの相対import / re-exportは拡張子なしとし、型チェックはBundler module resolutionを使う。
実装とtestは `packages/relay/` に置き、`@nethernet-proxy/relay` として公開する。
rootの `pnpm build` / `pnpm test` はworkspace内の各packageのscriptを実行する。
開発用の起動scriptはrootの `main.ts` に置き、`pnpm dev` でsourceを直接実行する。

## 安全な切り替え

各streamの最初のfragmentでhook一覧と圧縮状態をsnapshotする。
登録変更はcopy-on-writeのみで、受信時に全selectorを走査しない。
途中でbeforeが追加されても既に転送したbatchは保持経路に変更しない。
解除したcallbackは進行中batchでは引き続き実行される。batch内のcallback変更も次batchから。

圧縮交渉済みでhookがなければ、frame headerのremaining数とbyte上限だけを追跡する。
parts配列、hook用Bufferコピー、reassembly、解凍、packet分割は作動しない。
SDP認証は受信経路に共通する接続時処理である。

## 圧縮交渉

初期s2cだけを最小限decodeし、ID143のNetworkSettingsのthresholdとalgorithmを読む。
受信batchの方式は交渉後のcompression headerから選び、encodeには保存設定を使う。
threshold=0は圧縮無効（交渉後の非圧縮header `0xff` は付く）。
交渉前はpayload先頭からcompression headerの有無を推測しない。
settings自身のbatchは開始時の未交渉状態でencodeし、次のbatchから設定を使う。
client/serverの設定はsession内で保持する。後からhook登録・解除しても破棄しない。

settingsの書き換え/破棄時は元settingsを追跡するが、前後の状態調整は行わない。
制御packetの変更は前後の圧縮状態を食い違わせ得る。設定を取得できない間のpacket注入はエラー。

## hookとafter

beforeのcallback例外/無効返り値/decode失敗は当該sessionを切断する。
置換BufferのID一致・body形式は利用側の契約とする。
undefined時はcallbackへ渡したBufferの変更を採用しない。

afterのみではfragmentごとに先に元frameを受理し、batch完成後に通知する。
before経路ではbatch全体を送信/queueに受理した後に通知する。
途中のsend失敗やcapacity超過ではafterを通知しない。
既に通知したqueueへの受理が、後の切断で相手へ届かない場合はある。
afterの例外やdecode失敗は中継を取り消さない。

各callbackのBufferは独立し、contextはfreezeする。
replacementのheaderから最小限のID部分だけを取り、元subclient bitsを付ける。
同内容のBufferでも置換とし、元packetのIDでhook処理を続ける。
Promiseは待たず、返されたrejectionは消費する。async関数の登録は拒否する。

## 注入とbackpressure

session.client/server.sendを主APIとし、sendToClient/Serverも同じ実装へ委譲する。
注入はhookを通さない。入力のbatch化で所有Bufferを作り、callerの後日の変更を隔離する。
中継batchが進行中なら注入frame列を保留し、中継全fragment受理・hook処理終了後に送る。
direction/channelを跨いだ順序は規定しない。

出力batchは全frameのcapacityをチェックしてから受理する。
保持before frame、接続待ちqueue、注入待ちqueueをsession共通のbyte/message予算に含め、
観測時点の全channel bufferedAmountもbyte予算に加える。
after用partsにはstreamごとのpayload上限とfragment timeoutを適用する。
SCTPの内部memory全体やwire上のin-flight量の上限を保証する数値ではない。

Reliableの不完全batchはtimeoutでsession切断。
Unreliableの欠落/順序変更/timeoutは部分batchを破棄して診断する。
UnreliableにReliable同様の到達保証は加えない。

## 終了と交渉

Session生成はWebRTC connection作成時のearly hookで行い、最初のmessageより先に受信経路を設定。
sessionOpen時点ではserver接続を開始していない。sessionReadyは4channel open時の一回通知。
HTTP応答完了とDataChannel openは別のタイミングになる。

offerはSDP/IDをsnapshotし、検証digestと期限をendpoint生成直前に再確認する。
検証中予約を含むsession数、client接続待ちを含む交渉数、SDPサイズ・timeoutを制限する。
HTTP中止、gateway停止、proxy停止は検証待ちから離脱し、遅れて検証が成功してもpeerを作らない。
HTTP応答を書き終えるまでは切断通知を監視する。

論理切断でsessionを一覧から取り除き、4streamのqueue/timer/reassembly参照を解放。
client/serverのpeerを閉じ、serverConnectorもcloseする。
closeのPromiseはWebRTC closeと、nethernetが100ms後に閉じるdiscovery socketを待つ。
通常event listenerの例外は診断に留め、teardownを止めない。
