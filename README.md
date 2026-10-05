# nethernet-proxy

BedrockのNetherNet通信を中継するTypeScript / ESMライブラリのworkspaceです。

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
