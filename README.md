# nethernet-proxy

BedrockのNetherNet通信を中継するTypeScript / ESMライブラリのworkspaceです。

## Packages

| Package                                              | 内容                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| [`@nethernet-proxy/relay`](packages/relay/README.md) | raw frame中継、session管理、Bufferベースのpacket hook・送信、HTTP signaling |

```sh
pnpm add @nethernet-proxy/relay
```

使い方・設定は [relayのREADME](packages/relay/README.md)、実装と検証範囲は
[実装ドキュメント](packages/relay/docs/implementation.md)と
[検証記録](packages/relay/docs/validation.md)を参照してください。

## 開発

Node.js `^24.11.0 || >=26.0.0` とpnpm 12.9.1を使用します。

```sh
pnpm install
pnpm build
pnpm check
pnpm lint
pnpm test
```

`pnpm dev` はrootの `main.ts` を実行します。`pnpm bench` / `pnpm probe` もrootから実行できます。
