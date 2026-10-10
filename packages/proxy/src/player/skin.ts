import type { ClientData } from '@serenityjs/protocol';
import type { SkinData, SkinImage } from '../protocol/player-skin';

function validImage(image: SkinImage) {
  return (
    Number.isSafeInteger(image.width) &&
    Number.isSafeInteger(image.height) &&
    image.width >= 0 &&
    image.height >= 0 &&
    image.data.length === image.width * image.height * 4
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const base64 = (value: string) => Buffer.from(value, 'base64');

/** Immutable view of a player's skin; replaced as a whole on each PlayerSkin change. */
export class PlayerSkin {
  readonly data: SkinData;

  constructor(data: SkinData) {
    // Same RGBA size checks as gophertunnel's Skin.validate; the cape may be empty.
    if (
      !validImage(data.skinImage) ||
      data.skinImage.data.length === 0 ||
      !validImage(data.capeImage) ||
      !data.animations.every((animation) => validImage(animation.image))
    )
      throw new Error('invalid_skin');
    this.data = deepFreeze(data);
    Object.freeze(this);
  }

  static fromClientData(data: ClientData) {
    return new PlayerSkin({
      id: data.SkinId,
      playFabId: '',
      resourcePatch: base64(data.SkinResourcePatch).toString('utf8'),
      skinImage: {
        width: data.SkinImageWidth,
        height: data.SkinImageHeight,
        data: base64(data.SkinData),
      },
      animations: data.AnimatedImageData.map((animation) => ({
        image: {
          width: animation.ImageWidth,
          height: animation.ImageHeight,
          data: base64(animation.Image),
        },
        type: animation.Type,
        frames: animation.Frames,
        expression: animation.AnimationExpression,
      })),
      capeImage: {
        width: data.CapeImageWidth,
        height: data.CapeImageHeight,
        data: base64(data.CapeData),
      },
      geometryData: base64(data.SkinGeometryData).toString('utf8'),
      geometryEngineVersion: base64(data.SkinGeometryDataEngineVersion).toString('utf8'),
      animationData: data.SkinAnimationData,
      capeId: data.CapeId,
      fullId: data.SkinId + data.CapeId,
      armSize: data.ArmSize,
      skinColor: data.SkinColor,
      personaPieces: data.PersonaPieces.map((piece) => ({
        pieceId: piece.PieceId,
        pieceType: piece.PieceType,
        packId: piece.PackId,
        isDefault: piece.IsDefault,
        productId: piece.ProductId,
      })),
      tintPieces: data.PieceTintColors.map((tint) => ({
        pieceType: tint.PieceType,
        colors: tint.Colors,
      })),
      isPremium: data.PremiumSkin,
      isPersona: data.PersonaSkin,
      isPersonaCapeOnClassic: data.CapeOnClassicSkin,
      isPrimaryUser: true,
      overrideAppearance: data.OverrideSkin,
      isTrusted: data.TrustedSkin,
      profileHash: '',
    });
  }

  get id() {
    return this.data.id;
  }

  get fullId() {
    return this.data.fullId;
  }

  get armSize() {
    return this.data.armSize;
  }

  get isPersona() {
    return this.data.isPersona;
  }

  get isPremium() {
    return this.data.isPremium;
  }

  get skinImage() {
    return this.data.skinImage;
  }

  get capeImage() {
    return this.data.capeImage;
  }

  getGeometry(): unknown {
    return JSON.parse(this.data.geometryData);
  }

  toPng(): Buffer {
    return PlayerSkin.toPng(this.data.skinImage);
  }

  static toPng(_image: SkinImage): Buffer {
    throw new Error('not_implemented');
  }
}
