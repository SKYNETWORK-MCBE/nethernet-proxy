/*!
 * Copied from SerenityJS main (MIT), unreleased as of @serenityjs/protocol 0.8.21.
 * Delete once the release that includes it is adopted.
 * 印: [MC] 0.8.21 から最新版マイクラ (1.26.51, protocol 2193) で変わった箇所 (https://mojang.github.io/bedrock-protocol-docs/1.26.51/)
 *     [Serenity] 0.8.21 以降に Serenity 側で入った修正 (MC とは無関係) / [local] このリポジトリ独自の調整
 * Copyright (c) 2024 SerenityJS
 * See THIRD_PARTY_NOTICES.md in this package for the source and full license.
 */
import { VarString } from '@serenityjs/binarystream';
import { DataPacket, Packet } from '@serenityjs/protocol';
import { Proto, Serialize } from '@serenityjs/raknet';

import { SafeRead } from './safe-read-stream';
import { SerializedSkin, Uuid } from './types';

// [MC] 末尾の isVerified を削除 (SerializedSkin の isTrusted に移動)
@Proto(Packet.PlayerSkin)
class PlayerSkinPacket extends DataPacket {
  @Serialize(Uuid) public uuid!: string;
  @Serialize(SerializedSkin) public skin!: SerializedSkin;
  @Serialize(VarString) public skinName!: string;
  @Serialize(VarString) public oldSkinName!: string;
}

export { PlayerSkinPacket };

// ここから下は Serenity に無い独自部分 (リリース後も残す)。
const SafePlayerSkinPacket = SafeRead(PlayerSkinPacket);

/** クライアント由来の PlayerSkin を読む。壊れた長さで固まらないよう境界チェック付きで読む。 */
export function readPlayerSkinPacket(buffer: Buffer): PlayerSkinPacket {
  return new SafePlayerSkinPacket(buffer).deserialize();
}
