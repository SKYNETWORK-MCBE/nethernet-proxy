import type { ClientData } from '@serenityjs/protocol';
import { SerializedSkin, type SkinImage } from '../protocol/types';

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

/** Immutable view of a player's skin; replaced as a whole on each PlayerSkin change. */
export class PlayerSkin {
  readonly data: SerializedSkin;

  constructor(data: SerializedSkin) {
    // RGBA サイズを検証する。ケープは空でもよい。
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
    return new PlayerSkin(SerializedSkin.from(data));
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
