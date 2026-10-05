import assert from 'node:assert/strict';
import { test, vi } from 'vite-plus/test';
import { Emitter } from '../src/index';
import type { SubscriptionState } from '../src/index';

const symbolEvent = Symbol('event');
interface Events {
  message: [text: string];
  leave: [id: string, reason: string];
  error: [message: string];
  newListener: [];
  removeListener: [];
  [symbolEvent]: [value: number];
}
const create = () => new Emitter<Events, 'message'>({ cancellable: ['message'] });

test('typed events, symbols and Node meta-event names are ordinary user events', () => {
  const emitter = create();
  const calls: unknown[] = [];
  emitter.on('message', (text) => calls.push(text));
  emitter.on('leave', (id, reason) => calls.push([id, reason]));
  emitter.on('error', (message) => calls.push(message));
  emitter.on('newListener', () => calls.push('new'));
  emitter.on('removeListener', () => calls.push('remove'));
  emitter.on(symbolEvent, (value) => calls.push(value));
  emitter.emit('message', 'hello');
  emitter.emit('leave', 'id', 'closed');
  emitter.emit('error', 'ordinary error event');
  emitter.emit('newListener');
  emitter.emit('removeListener');
  emitter.emit(symbolEvent, 42);
  assert.deepEqual(calls, ['hello', ['id', 'closed'], 'ordinary error event', 'new', 'remove', 42]);
  assert.equal(create().emit('message', 'no listeners'), true);
});

test('before runs first and false cancels remaining hooks and notifications', () => {
  const emitter = create();
  const calls: string[] = [];
  emitter.on('message', () => calls.push('on'));
  emitter.before('message', () => {
    calls.push('before');
    return true;
  });
  emitter.before('message', () => {
    calls.push('cancel');
    return false;
  });
  emitter.before('message', () => {
    calls.push('skipped');
  });
  assert.equal(emitter.emit('message', 'hello'), false);
  assert.deepEqual(calls, ['before', 'cancel']);
});

test('undefined permits dispatch and on return values do not cancel', () => {
  const emitter = create();
  emitter.before('message', () => {});
  emitter.on('message', () => false);
  assert.equal(emitter.emit('message', 'hello'), true);
});

test('non-cancellable events and async before callbacks are rejected at registration', () => {
  const emitter = create();
  assert.throws(() => {
    // @ts-expect-error leave is notification-only
    emitter.before('leave', () => false);
  }, /event_not_cancellable/);
  assert.throws(() => {
    // @ts-expect-error cancellation must be synchronous
    emitter.before('message', async () => false);
  }, /before_callback_must_be_synchronous/);
});

test('once does not skip the following listener and can be removed using the original callback', () => {
  const emitter = create();
  const calls: string[] = [];
  const once = () => calls.push('once');
  emitter.once('message', once).on('message', () => calls.push('on'));
  emitter.emit('message', 'first');
  emitter.emit('message', 'second');
  assert.deepEqual(calls, ['once', 'on', 'on']);
  emitter.once('message', once).off('message', once);
  emitter.emit('message', 'third');
  assert.deepEqual(calls, ['once', 'on', 'on', 'on']);
});

test('onceBefore is consumed even when it cancels; skipped once notifications remain', () => {
  const emitter = create();
  let notifications = 0;
  emitter.onceBefore('message', () => false);
  emitter.once('message', () => {
    notifications++;
  });
  assert.equal(emitter.emit('message', 'first'), false);
  assert.equal(emitter.beforeCount('message'), 0);
  assert.equal(emitter.listenerCount('message'), 1);
  assert.equal(emitter.emit('message', 'second'), true);
  assert.equal(notifications, 1);
  assert.equal(emitter.hasListeners('message'), false);
});

test('offBefore removes onceBefore using its original callback', () => {
  const emitter = create();
  const cancel = () => false;
  emitter.onceBefore('message', cancel).offBefore('message', cancel);
  assert.equal(emitter.emit('message', 'hello'), true);
});

test('duplicate registrations are removed one at a time, latest first', () => {
  const emitter = create();
  let calls = 0;
  const listener = () => {
    calls++;
  };
  emitter.on('message', listener).once('message', listener);
  emitter.off('message', listener);
  emitter.emit('message', 'first');
  emitter.emit('message', 'second');
  assert.equal(calls, 2);
  emitter.off('message', listener).off('message', listener);
  assert.equal(emitter.hasListeners('message'), false);
  calls = 0;
  emitter.once('message', listener).on('message', listener);
  emitter.emit('message', 'first');
  emitter.emit('message', 'second');
  assert.equal(calls, 3);
  assert.equal(emitter.listenerCount('message'), 1);
});

test('both phases use the emission-start snapshot for additions and removals', () => {
  const emitter = create();
  const calls: string[] = [];
  const removed = () => calls.push('removed');
  const added = () => calls.push('added');
  emitter.on('message', removed);
  emitter.onceBefore('message', () => {
    emitter.off('message', removed);
    emitter.on('message', added);
    emitter.before('message', () => {
      calls.push('later-before');
    });
  });
  emitter.emit('message', 'first');
  assert.deepEqual(calls, ['removed']);
  emitter.emit('message', 'second');
  assert.deepEqual(calls, ['removed', 'later-before', 'added']);
});

test('persistent emissions reuse the same listener arrays', () => {
  const emitter = create();
  let calls = 0;
  emitter.before('message', () => true);
  emitter.on('message', () => {
    calls++;
  });
  const { views } = emitter as unknown as {
    views: Map<string, { before: readonly unknown[]; listeners: readonly unknown[] }>;
  };
  const view = views.get('message')!;
  const { before, listeners } = view;
  emitter.emit('message', 'first');
  emitter.emit('message', 'second');
  assert.equal(calls, 2);
  assert.equal(view.before, before);
  assert.equal(view.listeners, listeners);
});

test('once is removed before invocation, including nested emissions', () => {
  const emitter = create();
  const calls: string[] = [];
  emitter.once('message', () => {
    calls.push('once');
    emitter.emit('message', 'nested');
  });
  emitter.on('message', (text) => calls.push(text));
  emitter.emit('message', 'outer');
  assert.deepEqual(calls, ['once', 'nested', 'outer']);
});

test('nested emission cannot consume a pending once twice in either phase', () => {
  for (const phase of ['listener', 'before'] as const) {
    const emitter = create();
    let nested = false;
    let calls = 0;
    const recurse = () => {
      if (nested) return;
      nested = true;
      emitter.emit('message', 'nested');
    };
    const once = () => {
      calls++;
    };
    if (phase === 'before') emitter.before('message', recurse).onceBefore('message', once);
    else emitter.on('message', recurse).once('message', once);
    emitter.emit('message', 'outer');
    assert.equal(calls, 1);
    assert.equal(emitter.subscriptions('message').total, 1);
  }
});

test('registration, removal and once consumption report immutable current counts', () => {
  const changes: SubscriptionState<keyof Events>[] = [];
  const emitter = new Emitter<Events, 'message'>({
    cancellable: ['message'],
    onSubscriptionChange: (state) => changes.push(state),
  });
  const on = () => {};
  const before = () => true;
  emitter.on('message', on);
  emitter.before('message', before);
  emitter.once('message', () => {});
  emitter.emit('message', 'first');
  emitter.off('message', on);
  emitter.offBefore('message', before);
  assert.deepEqual(
    changes.map(({ listeners, before, total }) => [listeners, before, total]),
    [
      [1, 0, 1],
      [1, 1, 2],
      [2, 1, 3],
      [1, 1, 2],
      [0, 1, 1],
      [0, 0, 0],
    ],
  );
  assert.ok(changes.every(Object.isFrozen));
  emitter.off('message', on);
  assert.equal(changes.length, 6);
});

test('subscription-change callback can be removed independently and idempotently', () => {
  const emitter = create();
  let changes = 0;
  const listener = () => {
    changes++;
  };
  const stop = emitter.onSubscriptionChange(listener);
  const stopOther = emitter.onSubscriptionChange(listener);
  stop();
  stop();
  emitter.on('message', () => {});
  assert.equal(changes, 1);
  stopOther();
  emitter.clear();
  assert.equal(changes, 1);
});

test('last once removal is observable before its callback runs', () => {
  const emitter = create();
  let needed = false;
  emitter.onSubscriptionChange(({ total }) => {
    needed = total > 0;
  });
  emitter.once('message', () => assert.equal(needed, false));
  assert.equal(needed, true);
  emitter.emit('message', 'hello');
  assert.equal(needed, false);
});

test('remove-all separates phases and keeps change tracking installed', () => {
  const emitter = create();
  const totals: number[] = [];
  emitter.onSubscriptionChange(({ total }) => totals.push(total));
  emitter.on('message', () => {}).before('message', () => true);
  emitter.removeAllListeners('message');
  assert.equal(emitter.beforeCount('message'), 1);
  emitter.removeAllBefore('message');
  assert.deepEqual(emitter.eventNames(), []);
  emitter.on('leave', () => {}).before('message', () => true);
  emitter.clear();
  assert.deepEqual(emitter.eventNames(), []);
  emitter.once('message', () => {});
  emitter.emit('message', 'hello');
  assert.equal(totals.at(-1), 0);
});

test('without an error handler synchronous listener errors propagate', () => {
  const emitter = create();
  const error = new Error('listener failed');
  emitter.on('message', () => {
    throw error;
  });
  assert.throws(
    () => emitter.emit('message', 'hello'),
    (value) => value === error,
  );
});

test('with an error handler notifications continue but before errors fail closed', () => {
  const errors: { error: unknown; phase: string }[] = [];
  const emitter = new Emitter<Events, 'message'>({
    cancellable: ['message'],
    onError: (error, { phase }) => errors.push({ error, phase }),
  });
  let notifications = 0;
  emitter.on('message', () => {
    throw new Error('observer failed');
  });
  emitter.on('message', () => {
    notifications++;
  });
  assert.equal(emitter.emit('message', 'hello'), true);
  assert.equal(notifications, 1);
  emitter.before('message', () => {
    throw new Error('policy failed');
  });
  assert.equal(emitter.emit('message', 'hello'), false);
  assert.equal(notifications, 1);
  assert.deepEqual(
    errors.map(({ phase }) => phase),
    ['listener', 'before'],
  );
});

test('ordinary notification promises are not awaited and rejections reach onError', async () => {
  const errors: unknown[] = [];
  const emitter = new Emitter<Events>({ onError: (error) => errors.push(error) });
  const error = new Error('async observer failed');
  let completed = false;
  emitter.on('message', async () => {
    await Promise.resolve();
    completed = true;
    throw error;
  });
  assert.equal(emitter.emit('message', 'hello'), true);
  assert.equal(completed, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, true);
  assert.deepEqual(errors, [error]);
});

test('hidden before promises and invalid results fail closed and consume rejections', async () => {
  const errors: unknown[] = [];
  const emitter = new Emitter<Events, 'message'>({
    cancellable: ['message'],
    onError: (error) => errors.push(error),
  });
  // @ts-expect-error promise results are forbidden even from non-async functions
  emitter.onceBefore('message', () => Promise.reject(new Error('ignored promise')));
  assert.equal(emitter.emit('message', 'hello'), false);
  // @ts-expect-error only boolean or void can be returned
  emitter.onceBefore('message', () => 'no');
  assert.equal(emitter.emit('message', 'hello'), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    errors.map((error) => (error as Error).message),
    ['before_callback_must_be_synchronous', 'invalid_before_result'],
  );
});

test('event names and argument tuples are checked by TypeScript', () => {
  const checkTypes = (emitter: Emitter<Events, 'message'>) => {
    // @ts-expect-error unknown event
    emitter.on('missing', () => {});
    // @ts-expect-error wrong argument type
    emitter.emit('message', 42);
    // @ts-expect-error missing argument
    emitter.emit('leave', 'id');
    // @ts-expect-error wrong listener argument type
    emitter.on('message', (text: number) => text);
  };
  assert.equal(typeof checkTypes, 'function');
});

test('reentrant subscription changes preserve transition order for every observer', () => {
  const emitter = create();
  const calls: number[] = [];
  const added = () => {};
  let mutated = false;
  emitter.onSubscriptionChange(({ total }) => {
    if (total === 1 && !mutated) {
      mutated = true;
      emitter.on('message', added);
    }
  });
  emitter.onSubscriptionChange(({ total }) => calls.push(total));
  emitter.on('message', () => {});
  assert.deepEqual(calls, [1, 2]);
  assert.equal(emitter.listenerCount('message'), 2);
});

test('reentrant final removal leaves observers with zero demand', () => {
  const emitter = create();
  const totals: number[] = [];
  emitter.onSubscriptionChange(({ total }) => {
    if (total === 1) emitter.removeAllListeners('message');
  });
  emitter.onSubscriptionChange(({ total }) => totals.push(total));
  emitter.on('message', () => {});
  assert.deepEqual(totals, [1, 0]);
  assert.equal(emitter.hasListeners('message'), false);
});

test('idle event metadata is released after removal and once consumption', () => {
  const emitter = create();
  const internals = emitter as unknown as {
    views: Map<unknown, unknown>;
  };
  emitter.once('message', () => {});
  emitter.emit('message', 'hello');
  emitter.on(symbolEvent, () => {});
  emitter.removeAllListeners(symbolEvent);
  assert.equal(internals.views.size, 0);
  emitter.on('message', () => {}).before('message', () => true);
  emitter.clear();
  assert.equal(internals.views.size, 0);
});

test('re-registration during removal is not removed again or iterated indefinitely', () => {
  const emitter = create();
  let readded = false;
  let calls = 0;
  emitter.on('message', () => {});
  emitter.onSubscriptionChange(({ event, total }) => {
    if (event === 'message' && total === 0 && !readded) {
      readded = true;
      emitter.on('message', () => {
        calls++;
      });
    }
  });
  emitter.removeAllListeners();
  emitter.emit('message', 'hello');
  assert.equal(calls, 1);
});

test('remove-all keeps re-registrations of the same callback', () => {
  const emitter = create();
  let readded = false;
  let calls = 0;
  const listener = () => {
    calls++;
  };
  emitter.on('message', listener).on('message', listener);
  emitter.onSubscriptionChange(({ total }) => {
    if (total === 1 && !readded) {
      readded = true;
      emitter.on('message', listener);
    }
  });
  emitter.removeAllListeners('message');
  emitter.emit('message', 'hello');
  assert.equal(calls, 1);
});

test('maxListeners validates limits and warns once per phase until reduced to one', () => {
  for (const maxListeners of [-1, NaN])
    assert.throws(() => new Emitter<Events>({ maxListeners }), RangeError);
  assert.throws(() => {
    // @ts-expect-error JavaScript callers can supply invalid types
    new Emitter<Events>({ maxListeners: '1' });
  }, TypeError);
  const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  try {
    const emitter = new Emitter<Events, 'message'>({ maxListeners: 1, cancellable: ['message'] });
    const listener = () => {};
    emitter.on('message', listener).on('message', listener).on('message', listener);
    emitter.before('message', listener).before('message', listener);
    assert.equal(warn.mock.calls.length, 2);
    assert.equal((warn.mock.calls[0][0] as Error).name, 'MaxListenersExceededWarning');
    emitter.off('message', listener).off('message', listener).on('message', listener);
    assert.equal(warn.mock.calls.length, 3);
    emitter.clear().on('message', listener).on('message', listener);
    assert.equal(warn.mock.calls.length, 4);
    for (const maxListeners of [0, Infinity]) {
      const unlimited = new Emitter<Events>({ maxListeners });
      unlimited.on('message', listener).on('message', listener);
    }
    assert.equal(warn.mock.calls.length, 4);
  } finally {
    warn.mockRestore();
  }
});

test('subscription callback errors can be reported without losing later observers', () => {
  const errors: string[] = [];
  const totals: number[] = [];
  const emitter = new Emitter<Events>({ onError: (_, { phase }) => errors.push(phase) });
  emitter.onSubscriptionChange(() => {
    throw new Error('observer failed');
  });
  emitter.onSubscriptionChange(({ total }) => totals.push(total));
  emitter.on('message', () => {});
  emitter.clear();
  assert.deepEqual(totals, [1, 0]);
  assert.deepEqual(errors, ['subscriptions', 'subscriptions']);
});

test('async subscription callbacks are rejected and hidden promise results are reported', async () => {
  const errors: unknown[] = [];
  const emitter = new Emitter<Events>({ onError: (error) => errors.push(error) });
  assert.throws(() => emitter.onSubscriptionChange(async () => {}), /must_be_synchronous/);
  const stop = emitter.onSubscriptionChange(() => Promise.reject(new Error('ignored promise')));
  emitter.on('message', () => {});
  stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((errors[0] as Error).message, 'subscriptions_callback_must_be_synchronous');
});

test('removed once snapshots survive event deletion and same-event re-registration', () => {
  const emitter = create();
  const calls: string[] = [];
  emitter.once('message', () => calls.push('once'));
  emitter.onceBefore('message', () => {
    emitter.removeAllListeners('message');
    emitter.on('message', () => calls.push('new'));
  });
  emitter.emit('message', 'first');
  emitter.emit('message', 'second');
  assert.deepEqual(calls, ['once', 'new']);
});
