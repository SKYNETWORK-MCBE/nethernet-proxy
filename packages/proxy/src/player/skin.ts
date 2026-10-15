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
    return new PlayerSkin(SerializedSkin.from(data));
  }

  get id() {
    return this.data.identifier;
  }

  get fullId() {
    return this.data.fullIdentifier;
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
