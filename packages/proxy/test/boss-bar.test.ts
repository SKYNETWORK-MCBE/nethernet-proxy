import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { BossBar, BossBarColor, BossBarOverlay } from '../src/index';
import type { Player } from '../src/index';
import { DataPacket, Packet, ServerboundLoadingScreenType, Vector3f } from '@serenityjs/protocol';
import { ActorMetadataType, AddActorPacket, BossEventPacket, BossEventType } from '../src/protocol';

function viewer() {
  const sent: Buffer[] = [];
  const hooks: { id: number; callback: (buffer: Buffer) => void; active: boolean }[] = [];
  const player = {
    isValid: true,
    bossBars: new Set(),
    initialState: { position: { x: 1, y: 64, z: 2 } },
    send: (packet: DataPacket) => sent.push(packet.serialize()),
    session: {
      client: { send: (buffer: Buffer) => sent.push(buffer) },
      packetHandler: (id: number, options: { direction?: string }) => {
        assert.equal(options.direction, 'c2s');
        return {
          after: (callback: (buffer: Buffer) => void) => {
            const hook = { id, callback, active: true };
            hooks.push(hook);
            return () => (hook.active = false);
          },
        };
      },
    },
  };
  const activeHooks = () => hooks.filter((hook) => hook.active);
  return { player: player as unknown as Player, state: player, sent, activeHooks };
}
const decode = (buffer: Buffer) => new BossEventPacket(buffer).deserialize();
// Packet ids: 13 AddActor, 14 RemoveActor, 74 BossEvent
const ids = (sent: Buffer[]) => sent.map((buffer) => buffer[0]);
// ServerboundLoadingScreen as the client sends it: id 312, zigzag type, optional u32 screen id.
const loadingScreen = (type: ServerboundLoadingScreenType) =>
  Buffer.from(`b802${(type * 2).toString(16).padStart(2, '0')}0101000000`, 'hex');

test('BossEvent uses the 1.26.50 flat layout', () => {
  const packet = new BossEventPacket();
  packet.bossUniqueId = -5n;
  packet.type = BossEventType.Show;
  packet.title = 'ab';
  packet.filteredTitle = 'ab';
  packet.percent = 0.5;
  packet.color = BossBarColor.Blue;
  packet.overlay = BossBarOverlay.Notched10;
  // id 74, zigzag(-5)=9, u8 type, title x2, f32le, u8 color, u8 overlay
  assert.equal(
    packet.serialize().toString('hex'),
    '4a' + '09' + '00' + '026162' + '026162' + '0000003f' + '01' + '02',
  );
});

test('AddActor uses the 1.26.50 metadata layout with the legacy type byte', () => {
  const packet = new AddActorPacket();
  packet.uniqueId = -1n;
  packet.runtimeId = 1n;
  packet.identifier = 'a';
  packet.position = new Vector3f(0, 0, 0);
  packet.velocity = new Vector3f(0, 0, 0);
  packet.metadata = [
    { key: 38, type: ActorMetadataType.Float, value: 0 },
    { key: 0, type: ActorMetadataType.Long, value: 32n },
  ];
  packet.links = [{ ridden: -1n, rider: 1n, type: 2, immediate: true, riderInitiated: false }];
  const hex = packet.serialize().toString('hex');
  assert.equal(
    hex,
    '0d' +
      '01' +
      '01' +
      '0161' +
      '00'.repeat(24 + 16) +
      '00' +
      // metadata sorted by key: (0, long 7, 7, zigzag 32) (38, float 3, 3, 0f)
      '02' +
      '00070740' +
      '26030300000000' +
      '00' +
      '00' +
      // link: ridden zigzag(-1), rider zigzag(1), type, immediate, riderInitiated, f32
      '01' +
      '01' +
      '02' +
      '02' +
      '01' +
      '00' +
      '00000000',
  );
  const decoded = new AddActorPacket(Buffer.from(hex, 'hex')).deserialize();
  assert.deepEqual(decoded.metadata[0], { key: 0, type: ActorMetadataType.Long, value: 32n });
  assert.equal(decoded.links[0].ridden, -1n);
});

test('show, broadcast updates, hide and closed viewers', () => {
  const a = viewer();
  const b = viewer();
  const bar = new BossBar({ title: 'Boss', percent: 2, color: BossBarColor.Red });
  const other = new BossBar();
  assert.notEqual(bar.uniqueId, other.uniqueId);
  assert.ok(bar.uniqueId > 1n << 62n);

  bar.show(a.player);
  bar.show(b.player);
  // An invisible dummy actor first, then the bar pointing at it.
  assert.deepEqual(ids(a.sent), [13, 74]);
  const dummy = new AddActorPacket(a.sent[0]).deserialize();
  assert.equal(dummy.uniqueId, bar.uniqueId);
  assert.equal(dummy.runtimeId, bar.uniqueId);
  assert.equal(dummy.position.y, 54);
  const shown = decode(a.sent[1]);
  assert.equal(shown.type, BossEventType.Show);
  assert.equal(shown.bossUniqueId, bar.uniqueId);
  assert.equal(shown.title, 'Boss');
  assert.equal(shown.percent, 1);
  assert.equal(shown.color, BossBarColor.Red);
  assert.ok(a.player.bossBars.has(bar));

  bar.percent = 0.25;
  bar.title = 'Phase 2';
  bar.overlay = BossBarOverlay.Notched6;
  assert.deepEqual(
    a.sent.slice(2).map((buffer) => decode(buffer).type),
    [BossEventType.HealthPercentage, BossEventType.Title, BossEventType.Texture],
  );
  const last = decode(b.sent.at(-1)!);
  assert.equal(last.title, 'Phase 2');
  assert.equal(last.percent, 0.25);
  assert.equal(last.overlay, BossBarOverlay.Notched6);
  // The same serialized buffer is shared by every viewer.
  assert.equal(a.sent.at(-1), b.sent.at(-1));
  assert.throws(() => (bar.percent = Number.NaN), /invalid_boss_bar_percent/);

  bar.hide(a.player);
  assert.deepEqual(ids(a.sent.slice(-2)), [74, 14]);
  assert.equal(decode(a.sent.at(-2)!).type, BossEventType.Hide);
  assert.ok(!a.player.bossBars.has(bar));
  const count = a.sent.length;
  bar.hide(a.player);
  bar.color = BossBarColor.Green;
  assert.equal(a.sent.length, count);

  // A closed viewer is dropped on the next update without sending.
  b.state.isValid = false;
  const sent = b.sent.length;
  bar.title = 'gone';
  assert.equal(b.sent.length, sent);
  assert.equal(bar.players.size, 0);
  assert.throws(() => bar.show(b.player), /player_closed/);

  bar.show(a.player);
  other.show(a.player);
  bar.hide();
  assert.deepEqual([...a.player.bossBars], [other]);
});

test('a c2s dimension-change hook exists only while a bar is shown and re-shows every bar', () => {
  const a = viewer();
  const first = new BossBar({ title: 'one' });
  const second = new BossBar({ title: 'two' });
  first.show(a.player);
  second.show(a.player);
  assert.equal(a.activeHooks().length, 1);
  assert.equal(a.activeHooks()[0].id, Packet.ServerboundLoadingScreenPacket);

  // The start of a loading screen is ignored.
  a.sent.length = 0;
  a.activeHooks()[0].callback(loadingScreen(ServerboundLoadingScreenType.StartLoadingScreen));
  assert.equal(a.sent.length, 0);

  // After a dimension change: remove the stale dummy, add it again, show again, for each bar.
  a.activeHooks()[0].callback(loadingScreen(ServerboundLoadingScreenType.EndLoadingScreen));
  assert.deepEqual(ids(a.sent), [14, 13, 74, 14, 13, 74]);
  assert.deepEqual([decode(a.sent[2]).title, decode(a.sent[5]).title], ['one', 'two']);

  first.hide(a.player);
  assert.equal(a.activeHooks().length, 1);
  second.hide();
  assert.equal(a.activeHooks().length, 0);
  first.show(a.player);
  assert.equal(a.activeHooks().length, 1);
});
