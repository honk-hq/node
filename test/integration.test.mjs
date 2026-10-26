// Runs against a real Honk server when HONK_URL and HONK_KEY are set (see ../../README.md,
// "Integration tests"); skipped otherwise.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Honk, HonkAuthError, HonkConflictError, HonkValidationError, uuidv7 } from '../dist/esm/index.js';

const { HONK_URL, HONK_KEY } = process.env;
const skip = !HONK_URL || !HONK_KEY ? 'set HONK_URL and HONK_KEY to run against a real server' : false;
const run = `node-${Date.now()}`;

describe('integration (real server)', { skip }, () => {
  const honk = new Honk({ url: HONK_URL, key: HONK_KEY, defaults: { source: 'sdk-node-it', environment: 'test' } });

  test('minimal message is accepted', async () => {
    const res = await honk.honk({ message: `minimal ${run}` });
    assert.match(res.id, /^msg_/);
    assert.equal(res.duplicate, false);
    assert.ok(res.receivedAt instanceof Date && !Number.isNaN(res.receivedAt.getTime()));
  });

  test('every field is accepted, and a replay with the same key is a duplicate', async () => {
    const msg = {
      title: `Customer request ${run}`,
      message: 'Ana (Acme) asked for a quote:\nonline shop, 40 products',
      severity: 'info',
      priority: 'high',
      category: 'customers',
      source: 'sdk-node-it',
      environment: 'test',
      channel: 'requests',
      groupKey: `requests/${run}`,
      eventType: 'event',
      occurredAt: new Date(),
      url: 'https://example.com/admin/requests/4812',
      imageUrl: 'https://example.com/images/quote.png',
      metadata: { request_id: '4812', amount: 1250.5, vip: true },
      ttlSeconds: 600,
      sourceSequence: 1,
    };
    const key = `it-${await uuidv7()}`;
    const first = await honk.honk(msg, { idempotencyKey: key });
    const again = await honk.send(msg, { idempotencyKey: key }); // the old name: the very same request
    assert.equal(first.duplicate, false);
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id);
    assert.equal(again.receivedAt.getTime(), first.receivedAt.getTime());
  });

  test('a customer request with actions is accepted, and a replay is a duplicate', async () => {
    const msg = {
      title: `Customer request ${run}`,
      message: 'Emily Carter (Acme) asked for a quote: online shop, 40 products',
      category: 'customers',
      groupKey: `requests/${run}/actions`,
      actions: [
        { title: 'Reply', url: 'mailto:emily@example.com?subject=Your%20quote' },
        { title: 'Call Emily', url: 'tel:+15550134' },
        { title: 'Open request', url: 'https://example.com/admin/requests/4812' },
      ],
    };
    const key = `it-${await uuidv7()}`;
    const first = await honk.send(msg, { idempotencyKey: key });
    const again = await honk.send(msg, { idempotencyKey: key });
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id);
  });

  test('same key with a different payload is a HonkConflictError', async () => {
    const key = `it-${await uuidv7()}`;
    await honk.info('first', `payload A ${run}`, { idempotencyKey: key });
    await assert.rejects(honk.info('first', `payload B ${run}`, { idempotencyKey: key }), (e) => {
      assert.ok(e instanceof HonkConflictError);
      assert.equal(e.code, 'idempotency_conflict');
      assert.equal(e.status, 409);
      assert.equal(e.idempotencyKey, key);
      return true;
    });
  });

  test('uhoh then phew for one group; problem/recovery are the same requests', async () => {
    const group = `it/node/${run}`;
    const p = await honk.uhoh(group, 'Backup failed', 'pg_dump exited with 1', { sourceSequence: 1, idempotencyKey: `${group}/p` });
    const r = await honk.phew(group, 'Backup OK', 'pg_dump finished', { sourceSequence: 2, idempotencyKey: `${group}/r` });
    assert.notEqual(p.id, r.id);
    const p2 = await honk.problem(group, 'Backup failed', 'pg_dump exited with 1', { sourceSequence: 1, idempotencyKey: `${group}/p` });
    const r2 = await honk.recovery(group, 'Backup OK', 'pg_dump finished', { sourceSequence: 2, idempotencyKey: `${group}/r` });
    assert.deepEqual([p2.id, p2.duplicate, r2.id, r2.duplicate], [p.id, true, r.id, true]);
  });

  test('a horn alias and its canonical severity are the same event', async () => {
    const key = `it-${await uuidv7()}`;
    const first = await honk.loud('Disk 91%', `/var on app-01 ${run}`, { idempotencyKey: key });
    const again = await honk.send({ title: 'Disk 91%', message: `/var on app-01 ${run}`, severity: 'WARNING' }, { idempotencyKey: key });
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id);
  });

  test('a wrong key is a HonkAuthError (invalid_key)', async () => {
    const bad = new Honk({ url: HONK_URL, key: 'honk_000000000000_00000000000000000000000000000000' });
    await assert.rejects(bad.send({ message: 'x' }), (e) => e instanceof HonkAuthError && e.code === 'invalid_key' && e.status === 401);
  });

  test('urgent from a key without allow_urgent is accepted, lowered to high with a downgraded warning', async () => {
    const res = await honk.send({ message: `urgent ${run}`, priority: 'urgent' });
    assert.match(res.id, /^msg_/);
    const downgraded = res.warnings.filter((w) => w.field === 'priority');
    // A key with allow_urgent keeps urgent and has no warning.
    if (downgraded.length > 0) assert.equal(downgraded[0].code, 'downgraded');
  });

  test('what the server corrects comes back as warnings, not errors', async () => {
    const seen = [];
    const client = new Honk({ url: HONK_URL, key: HONK_KEY, onWarnings: (w) => seen.push(...w) });
    const actions = [{ title: 'Call', url: 'tel:+15550134' }, { title: 'Run', url: 'javascript:alert(1)' }];
    const res = await client.send({ message: `corrected ${run}`, title: 't'.repeat(200), severity: 'fatal', ttlSeconds: 5, actions });
    assert.match(res.id, /^msg_/);
    const got = res.warnings.map((w) => `${w.field}:${w.code}`);
    for (const want of ['title:truncated', 'ttl_seconds:clamped', 'actions[1].url:ignored']) assert.ok(got.includes(want), `${want} in ${got}`);
    assert.ok(res.warnings.some((w) => w.field === 'severity'), `a severity warning in ${got}`);
    assert.deepEqual(seen, res.warnings);
  });

  test('neither message nor title is refused locally; an unknown event type by the server', async () => {
    await assert.rejects(honk.send({ message: ' ' }), (e) => e instanceof HonkValidationError && e.local === true);
    await assert.rejects(honk.send({ message: 'x', eventType: 'incident' }), (e) => {
      assert.ok(e instanceof HonkValidationError);
      assert.equal(e.local, false);
      assert.equal(e.status, 422);
      assert.deepEqual(e.fields.map((f) => `${f.field}:${f.code}`), ['event_type:invalid_enum']);
      assert.match(e.requestId, /^req_/);
      return true;
    });
  });
});
