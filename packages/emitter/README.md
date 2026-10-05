# @nethernet-proxy/emitter

型付きのEventEmitter形式の購読、同期before hook、購読状況の変更通知を提供するNode.js / ESMライブラリです。
Bedrockやrelayには依存しません。listenerの管理・配送はMapとcopy-on-write配列で実装しています。
配送用snapshotは購読変更時だけ更新し、通常の発火ではlistener配列をコピーしません。

```ts
import { Emitter } from '@nethernet-proxy/emitter';

interface Events {
  chat: [event: { message: string }];
  playerLeave: [event: { connectionId: string; reason: string }];
}

const events = new Emitter<Events, 'chat'>({
  cancellable: ['chat'],
  onError: (error, context) => console.error(context.event, context.phase, error),
});

events.before('chat', ({ message }) => !message.includes('blocked'));
events.on('chat', ({ message }) => console.log(message));

if (events.emit('chat', { message: 'hello' })) {
  // 呼び出し側が許可された処理を実行する。
}
```

## 契約

- `on` / `once` / `off` は通常の通知listenerを操作し、`this`を返します。
- `before` / `onceBefore` / `offBefore` はconstructorの `cancellable` に指定したeventだけで利用できます。型と実行時の両方で制限します。
- beforeは登録順。`false` はキャンセル、`true` / `undefined` は許可。キャンセルすると残りのbeforeと通常listenerを呼びません。
- 通常listenerの返り値はキャンセルに使いません。
- **`emit()` の戻り値は許可なら `true`、キャンセルなら `false`。Nodeの「listenerが存在するか」とは違います。** 購読なしでも `true` です。
- emitterは通知を制御するだけです。packet破棄・接続拒否などは呼び出し側が戻り値を見て実行してください。`on()` も処理実行前に呼ばれるため、処理完了や転送完了の保証ではありません。
- 各emitの開始時にbeforeと通常listenerをsnapshotします。発火中の追加・解除は次回から反映し、解除済みlistenerが現在のemitで呼ばれる場合があります。
- onceはcallback実行前に解除します。通常listenerがキャンセルで呼ばれなければ、そのonceは残ります。
- `off()` は同じcallbackの最後の登録を1つ解除します。onceも元callbackで解除できます。
- `removeAllListeners(event?)` は通常listenerだけ、`removeAllBefore(event?)` はbeforeだけを解除します。`clear()` は両方を解除します。
- string / symbolのeventに対応します。`error` / `newListener` / `removeListener` も通常のevent名です。Nodeの特殊eventの挙動は公開しません。
- `after()` / `emitAsync()` はありません。beforeは同期、通常通知は `on()` を使います。

## 購読に応じた処理の切り替え

```ts
const stopWatching = events.onSubscriptionChange(({ event, listeners, before, total }) => {
  // ここでpacket追跡側の需要を更新する。emit中の解除も即時に通知される。
  // before > 0: 転送前の判定が必要
  // listeners > 0: 観測が必要
  // total === 0: このeventのためだけの処理は不要
});

events.listenerCount('chat');
events.beforeCount('chat');
events.hasListeners('chat');
events.subscriptions('chat'); // 不変な { event, listeners, before, total }
events.eventNames(); // beforeまたは通常listenerが存在するeventだけ

stopWatching(); // idempotent
```

変更通知は実際の登録・解除・once消費後に同期で発火します。購読開始時のreplayはありません。
変更callback内でさらに登録を変更した場合は通知を直列化し、全observerへ同じ順序で伝えます。
callback内で状態が変わる場合、通知のsnapshotと現在のcountsは異なり得ます。変更通知は外側の操作が戻るまでに処理します。
constructorの `onSubscriptionChange` でも登録できます。packetとの依存関係・内部状態管理の需要は利用側の責任です。
emitが必要かを判断するための毎packetの全event走査は不要です。

## エラーと非同期listener

- `onError(error, { event, phase })` 未設定なら、同期例外は呼び出し元へ伝播します。
- 設定時は通知listenerの例外を報告して次のlistenerへ進みます。beforeの例外・不正な返り値は報告し、**キャンセルとして扱います**。
- beforeと購読変更callbackは同期です。async関数の登録を拒否し、隠れたPromiseの返り値も検出してrejectionを消費します。
- 通常listenerのPromiseは待ちません。rejectionは `onError` へ通知します。未設定の場合は次tickに例外として再送出するため、非同期listenerを使うアプリケーションは `onError` を設定してください。
- `onError` 自体は例外を投げない同期の診断callbackとして使ってください。
- `maxListeners` は各event・phaseの警告閾値で、既定10。0で無効化できます。超過時は `process.emitWarning()` で `MaxListenersExceededWarning` を通知します。
