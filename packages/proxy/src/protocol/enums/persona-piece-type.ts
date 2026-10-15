/*!
 * Copied from SerenityJS main (MIT), unreleased as of @serenityjs/protocol 0.8.21.
 * Delete once the release that includes it is adopted.
 * 印: [MC] 0.8.21 から最新版マイクラ (1.26.51, protocol 2193) で変わった箇所 (https://mojang.github.io/bedrock-protocol-docs/1.26.51/)
 *     [Serenity] 0.8.21 以降に Serenity 側で入った修正 (MC とは無関係) / [local] このリポジトリ独自の調整
 * Copyright (c) 2024 SerenityJS
 * See THIRD_PARTY_NOTICES.md in this package for the source and full license.
 */
// [MC] 追加 (persona piece の type が string から数値になったため)
enum PersonaPieceType {
  Unknown,
  Skeleton,
  Body,
  Skin,
  Bottom,
  Feet,
  Dress,
  Top,
  HighPants,
  Hands,
  Outerwear,
  FacialHair,
  Mouth,
  Eyes,
  Hair,
  Hood,
  Back,
  FaceAccessory,
  Head,
  Legs,
  LeftLeg,
  RightLeg,
  Arms,
  LeftArm,
  RightArm,
  Capes,
  ClassicSkin,
  Emote,
  Unsupported,
}

export { PersonaPieceType };
