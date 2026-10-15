/*!
 * Viewer-set design based on SerenityJS Bossbar (MIT).
 * Copyright (c) 2024 SerenityJS
 * See THIRD_PARTY_NOTICES.md in this package for the source and full license.
 */
import {
  Packet,
  RemoveEntityPacket,
  ServerboundLoadingScreenPacketPacket,
  ServerboundLoadingScreenType,
  Vector3f,
} from '@serenityjs/protocol';
import {
  ActorMetadataType,
  AddActorPacket,
  BossbarColor,
  BossbarOverlay,
  BossEventPacket,
  BossEventType,
} from '../protocol';
import type { Player } from '../player';

export interface BossbarOptions {
  title?: string;
  /** 0.0-1.0 */
  percent?: number;
  color?: BossbarColor;
  overlay?: BossbarOverlay;
}

// Server-assigned actor ids never reach this range; ids are per client, so one id per bar suffices.
let nextUniqueId = 0x7fff_ffff_ffff_ffffn;

// While a player sees any bar, re-show them after a dimension change (the client drops them).
// This c2s hook decodes every c2s batch of that session, so it only exists while needed.
const dimensionHooks = new WeakMap<Player, () => void>();

/**
 * A boss bar owned by the proxy. One bar can be shown to many players; updates go to all of them.
 * The client only shows bars of known entities, so each viewer gets an invisible dummy actor.
 */
export class Bossbar {
  readonly uniqueId = nextUniqueId--;
  private readonly viewers = new Set<Player>();
  #title: string;
  #percent: number;
  #color: BossbarColor;
  #overlay: BossbarOverlay;

  constructor(options: BossbarOptions = {}) {
    this.#title = options.title ?? '';
    this.#percent = checkPercent(options.percent ?? 1);
    this.#color = options.color ?? BossbarColor.Pink;
    this.#overlay = options.overlay ?? BossbarOverlay.Progress;
  }

  get players(): ReadonlySet<Player> {
    return new Set(this.viewers);
  }

  get title() {
    return this.#title;
  }
  set title(value: string) {
    this.#title = value;
    this.broadcast(BossEventType.Title);
  }

  get percent() {
    return this.#percent;
  }
  set percent(value: number) {
    this.#percent = checkPercent(value);
    this.broadcast(BossEventType.HealthPercentage);
  }

  get color() {
    return this.#color;
  }
  set color(value: BossbarColor) {
    this.#color = value;
    this.broadcast(BossEventType.Texture);
  }

  get overlay() {
    return this.#overlay;
  }
  set overlay(value: BossbarOverlay) {
    this.#overlay = value;
    this.broadcast(BossEventType.Texture);
  }

  /** Shows the bar. Calling it again for a viewer re-sends the bar with its current state. */
  show(player: Player) {
    if (!player.isValid) throw new Error('player_closed');
    if (this.viewers.has(player)) player.send(this.removeDummy());
    this.viewers.add(player);
    const bars = player.bossbars as Set<Bossbar>;
    bars.add(this);
    if (!dimensionHooks.has(player)) dimensionHooks.set(player, watchDimension(player));
    player.send(this.dummy(player));
    player.session.client.send(this.packet(BossEventType.Show));
  }

  /** Hides the bar from the player, or from every viewer when omitted. */
  hide(player?: Player) {
    const targets = player ? (this.viewers.has(player) ? [player] : []) : [...this.viewers];
    if (!targets.length) return;
    const buffer = this.packet(BossEventType.Hide);
    const remove = this.removeDummy().serialize();
    for (const target of targets) {
      this.viewers.delete(target);
      const bars = target.bossbars as Set<Bossbar>;
      bars.delete(this);
      if (!bars.size) {
        dimensionHooks.get(target)?.();
        dimensionHooks.delete(target);
      }
      if (!target.isValid) continue;
      target.session.client.send(buffer);
      target.session.client.send(remove);
    }
  }

  private broadcast(type: BossEventType) {
    if (!this.viewers.size) return;
    const buffer = this.packet(type);
    for (const viewer of this.viewers) {
      if (!viewer.isValid) this.hide(viewer);
      else viewer.session.client.send(buffer);
    }
  }

  private packet(type: BossEventType) {
    const packet = new BossEventPacket();
    packet.bossUniqueId = this.uniqueId;
    packet.type = type;
    packet.title = this.#title;
    packet.filteredTitle = this.#title;
    packet.percent = this.#percent;
    packet.color = this.#color;
    packet.overlay = this.#overlay;
    return packet.serialize();
  }

  // Invisible, zero-scale, AI-less creeper below the initial position. Distance does not hide the bar.
  private dummy(player: Player) {
    const { x, y, z } = player.initialState.position;
    const packet = new AddActorPacket();
    packet.uniqueId = this.uniqueId;
    packet.runtimeId = this.uniqueId;
    packet.identifier = 'minecraft:creeper';
    packet.position = new Vector3f(x, y - 10, z);
    packet.velocity = new Vector3f(0, 0, 0);
    packet.metadata = [
      // Flags: Invisible (bit 5) | NoAI (bit 16)
      { key: 0, type: ActorMetadataType.Long, value: (1n << 5n) | (1n << 16n) },
      // Scale
      { key: 38, type: ActorMetadataType.Float, value: 0 },
    ];
    return packet;
  }

  private removeDummy() {
    const packet = new RemoveEntityPacket();
    packet.uniqueEntityId = this.uniqueId;
    return packet;
  }
}

// The client ends the dimension-change loading screen with ServerboundLoadingScreen(End).
// It arrives after PlayerAction ChangeDimensionAck, once the new dimension has loaded.
function watchDimension(player: Player) {
  return player.session
    .packetHandler(Packet.ServerboundLoadingScreenPacket, { direction: 'c2s' })
    .after((buffer) => {
      if (!player.isValid) return;
      const packet = new ServerboundLoadingScreenPacketPacket(buffer).deserialize();
      if (packet.type !== ServerboundLoadingScreenType.EndLoadingScreen) return;
      for (const bar of player.bossbars) bar.show(player);
    });
}

function checkPercent(value: number) {
  if (!Number.isFinite(value)) throw new Error('invalid_boss_bar_percent');
  return Math.min(1, Math.max(0, value));
}
