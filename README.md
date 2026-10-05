# nethernet-proxy

BedrockのNetherNet通信を中継するTypeScript / ESMライブラリのworkspaceです。

## Packages

| Package                                                  | 内容                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`@nethernet-proxy/relay`](packages/relay/README.md)     | raw frame中継、session管理、Bufferベースのpacket hook・送信、HTTP signaling |
| [`@nethernet-proxy/emitter`](packages/emitter/README.md) | 型付きイベント、同期キャンセル、購読状況の変更通知                          |

```sh
pnpm add @nethernet-proxy/relay
```

使い方・設定は [relayのREADME](packages/relay/README.md)、内部の処理契約は
[実装ドキュメント](packages/relay/docs/implementation.md)を参照してください。

上位ライブラリ `@nethernet-proxy/proxy` の設計は [API実装計画](docs/proxy-api-plan.md)にまとめています。

## 開発

Node.js `^24.11.0 || >=26.0.0` とpnpm 12.9.1を使用します。

```sh
pnpm install
pnpm build
pnpm check
pnpm lint
pnpm test
```

`pnpm dev` はrootの `main.ts` を実行します。
