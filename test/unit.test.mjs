import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import {
  Honk,
  HonkAuthError,
  HonkConflictError,
  HonkError,
  HonkNetworkError,
  HonkQuotaError,
  HonkServerError,
  HonkTimeoutError,
  HonkValidationError,
  SEVERITY_ALIASES,
  Severity,
  VERSION,
  buildBody,
  normalizeSeverity,
  parseRetryAfter,
  uuidv7,
} from '../dist/esm/index.js';
import { KEY, apiError, mockServer, ok } from './mock-server.mjs';

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fast = { backoff: { baseMs: 1, maxMs: 5 } };
const servers = [];
async function server(steps) {
  const s = await mockServer(steps);
  servers.push(s);
  return s;
}
after(() => Promise.all(servers.map((s) => s.close())));

describe('serialisation', () => {
  test('sends every field with the exact openapi names, headers and a UUIDv7 key', async () => {
    const s = await server(ok());
    const honk = new Honk({ url: s.url, key: KEY });
    const res = await honk.send({
      title: 'Redis connection failed',
      message: 'Billing API could not connect to Redis after 3 attempts.',
      severity: 'error',
      priority: 'high',
      category: 'infrastructure',
      source: 'billing-api',
      environment: 'production',
      channel: 'infrastructure',
      groupKey: 'billing/redis/connectivity',
      eventType: 'problem',
      occurredAt: new Date('2026-10-02T00:10:00+03:00'),
      url: 'https://example.com/incidents/redis',
      imageUrl: 'https://cdn.example.com/a.jpg',
      metadata: { host: 'app-01', attempts: 3, retried: true },
      ttlSeconds: 3600,
      sourceSequence: 42,
    });
    assert.deepEqual(res, { id: 'msg_01k6h3w4z5x6y7z8a9b0c1d2e3', duplicate: false, receivedAt: new Date('2026-10-02T21:10:00.123Z'), warnings: [] });
    const [r] = s.requests;
    assert.equal(r.method, 'POST');
    assert.equal(r.url, '/v1/messages');
    assert.equal(r.headers.authorization, `Bearer ${KEY}`);
    assert.equal(r.headers['content-type'], 'application/json');
    assert.match(r.headers['idempotency-key'], UUIDV7);
    assert.equal(r.headers['user-agent'], `honk-node/${VERSION}`);
    assert.deepEqual(r.json, {
      title: 'Redis connection failed',
      message: 'Billing API could not connect to Redis after 3 attempts.',
      severity: 'error',
      priority: 'high',
      category: 'infrastructure',
      source: 'billing-api',
      environment: 'production',
      channel: 'infrastructure',
      group_key: 'billing/redis/connectivity',
      event_type: 'problem',
      occurred_at: '2026-10-01T21:10:00.000Z',
      url: 'https://example.com/incidents/redis',
      image_url: 'https://cdn.example.com/a.jpg',
      metadata: { host: 'app-01', attempts: 3, retried: true },
      ttl_seconds: 3600,
      source_sequence: 42,
    });
  });

  test('minimal message sends only message; null and empty optional fields are omitted', async () => {
    const s = await server(ok());
    await new Honk({ url: s.url, key: KEY }).send({ message: 'Backup finished in 42s', title: null, channel: '', groupKey: undefined });
    assert.equal(s.requests[0].raw, '{"message":"Backup finished in 42s"}');
  });

  test('actions are sent as [{ title, url }] in order; empty actions are omitted', async () => {
    const s = await server(ok());
    const honk = new Honk({ url: s.url, key: KEY });
    const actions = [
      { title: 'Reply', url: 'mailto:emily@example.com?subject=Your%20quote' },
      { title: 'Call Emily', url: 'tel:+15550134' },
      { title: 'Open request', url: 'https://shop.example.com/admin/requests/4812' },
    ];
    await honk.send({ message: 'Emily asked for a quote', actions });
    await honk.send({ message: 'x', actions: [] });
    await honk.send({ message: 'x', actions: null });
    await honk.loud('Disk 91%', '/var on app-01', { actions: [{ title: 'Text on-call', url: 'sms:+15550134?body=Disk%2091%25' }] });
    assert.equal(
      s.requests[0].raw,
      '{"message":"Emily asked for a quote","actions":[{"title":"Reply","url":"mailto:emily@example.com?subject=Your%20quote"},{"title":"Call Emily","url":"tel:+15550134"},{"title":"Open request","url":"https://shop.example.com/admin/requests/4812"}]}',
    );
    assert.equal(s.requests[1].raw, '{"message":"x"}');
    assert.equal(s.requests[2].raw, '{"message":"x"}');
    assert.deepEqual(s.requests[3].json.actions, [{ title: 'Text on-call', url: 'sms:+15550134?body=Disk%2091%25' }]);
  });

  test('defaults fill unset source/environment/channel; the message wins', async () => {
    const s = await server(ok());
    const honk = new Honk({ url: s.url, key: KEY, defaults: { source: 'laravel', environment: 'production', channel: '' } });
    await honk.send({ message: 'a' });
    await honk.send({ message: 'b', source: 'cron', channel: 'requests' });
    assert.deepEqual(s.requests[0].json, { message: 'a', source: 'laravel', environment: 'production' });
    assert.deepEqual(s.requests[1].json, { message: 'b', source: 'cron', environment: 'production', channel: 'requests' });
  });

  test('duplicate replies are reported', async () => {
    const s = await server(ok({ duplicate: true }));
    const res = await new Honk({ url: s.url, key: KEY }).send({ message: 'x' }, { idempotencyKey: 'deploy-4812' });
    assert.equal(res.duplicate, true);
    assert.equal(s.requests[0].headers['idempotency-key'], 'deploy-4812');
  });

  test('url is normalised (trailing slash, /v1/messages suffix)', async () => {
    const s = await server(ok());
    await new Honk({ url: `${s.url}/v1/messages/`, key: KEY }).send({ message: 'x' });
    assert.equal(s.requests[0].url, '/v1/messages');
  });

  test('helpers set event type, group key and severity', async () => {
    const s = await server(ok());
    const honk = new Honk({ url: s.url, key: KEY });
    await honk.problem('db/backup', 'Backup failed', 'pg_dump exited with 1', { idempotencyKey: 'p-1', channel: 'backups' });
    await honk.recovery('db/backup', 'Backup OK', 'pg_dump finished');
    await honk.warning('Disk 85%', 'app-01 /var', { severity: 'info' });
    await honk.critical(null, 'Payments down');
    await honk.problem('q/failed', 'Queue', 'failing', { severity: 'critical' });
    assert.deepEqual(s.requests[0].json, { title: 'Backup failed', message: 'pg_dump exited with 1', severity: 'error', channel: 'backups', group_key: 'db/backup', event_type: 'problem' });
    assert.equal(s.requests[0].headers['idempotency-key'], 'p-1');
    assert.deepEqual(s.requests[1].json, { title: 'Backup OK', message: 'pg_dump finished', severity: 'success', group_key: 'db/backup', event_type: 'recovery' });
    assert.equal(s.requests[2].json.severity, 'warning');
    assert.deepEqual(s.requests[3].json, { message: 'Payments down', severity: 'critical' });
    assert.equal(s.requests[4].json.severity, 'critical');
  });
});

describe('the Honk scale (severity aliases)', () => {
  test('constants: horn names are aliases of the canonical values', () => {
    assert.equal(Severity.Light, 'info');
    assert.equal(Severity.Beep, 'success');
    assert.equal(Severity.Loud, 'warning');
    assert.equal(Severity.Loud, Severity.Warning);
    assert.equal(Severity.Long, 'error');
    assert.equal(Severity.Blast, 'critical');
    assert.deepEqual(SEVERITY_ALIASES, { light: 'info', beep: 'success', loud: 'warning', long: 'error', blast: 'critical' });
  });

  test('normalizeSeverity is case-insensitive and keeps canonical values', () => {
    for (const [input, want] of [['loud', 'warning'], ['LOUD', 'warning'], [' Blast ', 'critical'], ['Beep', 'success'], ['light', 'info'], ['long', 'error'], ['warning', 'warning'], ['ERROR', 'error'], ['fatal', undefined]]) {
      assert.equal(normalizeSeverity(input), want, input);
    }
  });

  test('aliases are sent canonical, so the idempotency payload is the same', async () => {
    const s = await server(ok());
    const honk = new Honk({ url: s.url, key: KEY });
    await honk.send({ message: 'x', severity: 'loud' }, { idempotencyKey: 'k' });
    await honk.send({ message: 'x', severity: 'Warning' }, { idempotencyKey: 'k' });
    await honk.send({ message: 'x', severity: Severity.Loud }, { idempotencyKey: 'k' });
    assert.deepEqual(s.requests.map((r) => r.raw), Array(3).fill('{"message":"x","severity":"warning"}'));
  });

  test('aliases are sent canonical; unknown values go to the server as given', () => {
    assert.equal(buildBody({ message: 'x', severity: 'BLAST' }).severity, 'critical');
    assert.equal(buildBody({ message: 'x', severity: 'fatal' }).severity, 'fatal');
  });

  test('horn helpers', async () => {
    const s = await server(ok());
    const honk = new Honk({ url: s.url, key: KEY });
    await honk.light('a', 'm');
    await honk.beep('b', 'm');
    await honk.loud('c', 'm', { groupKey: 'disk/var' });
    await honk.long('d', 'm');
    await honk.blast('e', 'm', { severity: 'light' });
    await honk.problem('g', 'p', 'm', { severity: 'blast' });
    assert.deepEqual(s.requests.map((r) => r.json.severity), ['info', 'success', 'warning', 'error', 'critical', 'critical']);
    assert.equal(s.requests[2].json.group_key, 'disk/var');
  });
});

describe('honk, uhoh, phew (and their old names)', () => {
  const sameRequest = (r) => ({ method: r.method, url: r.url, headers: r.headers, raw: r.raw });

  test('honk/uhoh/phew set event type, group key and default severity', async () => {
    const s = await server(ok());
    const honk = new Honk({ url: s.url, key: KEY });
    const res = await honk.honk({ title: 'Someone bought 3 rubber chickens', message: 'Order 1042', severity: 'beep' }, { idempotencyKey: 'order-1042' });
    await honk.uhoh('oven/kitchen', 'The cake is burning', 'Oven at 260 °C', { channel: 'home', idempotencyKey: 'u-1' });
    await honk.phew('oven/kitchen', 'Cake saved', 'Nobody needs to know.', { sourceSequence: 2 });
    await honk.uhoh('oven/kitchen', null, 'Smoke everywhere', { severity: 'blast' });
    await honk.phew('oven/kitchen', 'Fine', 'really', { severity: 'light' });
    assert.equal(res.id, 'msg_01k6h3w4z5x6y7z8a9b0c1d2e3');
    assert.deepEqual(s.requests[0].json, { title: 'Someone bought 3 rubber chickens', message: 'Order 1042', severity: 'success' });
    assert.equal(s.requests[0].headers['idempotency-key'], 'order-1042');
    assert.deepEqual(s.requests[1].json, { title: 'The cake is burning', message: 'Oven at 260 °C', severity: 'error', channel: 'home', group_key: 'oven/kitchen', event_type: 'problem' });
    assert.equal(s.requests[1].headers['idempotency-key'], 'u-1');
    assert.deepEqual(s.requests[2].json, { title: 'Cake saved', message: 'Nobody needs to know.', severity: 'success', group_key: 'oven/kitchen', event_type: 'recovery', source_sequence: 2 });
    assert.deepEqual(s.requests[3].json, { message: 'Smoke everywhere', severity: 'critical', group_key: 'oven/kitchen', event_type: 'problem' });
    assert.equal(s.requests[4].json.severity, 'info');
  });

  test('send/problem/recovery send exactly what honk/uhoh/phew send', async () => {
    const s = await server(ok());
    const honk = new Honk({ url: s.url, key: KEY, defaults: { source: 'oven-pi' } });
    const msg = { title: 'Temperature', message: '180 °C', severity: 'loud', metadata: { celsius: 180 }, actions: [{ title: 'Call', url: 'tel:+15550134' }] };
    const opts = { channel: 'home', priority: 'high', sourceSequence: 7, metadata: { oven: 'kitchen' } };
    const pairs = [
      [() => honk.honk(msg, { idempotencyKey: 'k-send' }), () => honk.send(msg, { idempotencyKey: 'k-send' })],
      [() => honk.uhoh('oven/kitchen', 'The cake is burning', 'smoke', { ...opts, idempotencyKey: 'k-p' }), () => honk.problem('oven/kitchen', 'The cake is burning', 'smoke', { ...opts, idempotencyKey: 'k-p' })],
      [() => honk.phew('oven/kitchen', 'Cake saved', 'Nobody needs to know.', { ...opts, idempotencyKey: 'k-r' }), () => honk.recovery('oven/kitchen', 'Cake saved', 'Nobody needs to know.', { ...opts, idempotencyKey: 'k-r' })],
      [() => honk.uhoh('g', null, 'm', { severity: 'BLAST', idempotencyKey: 'k-o' }), () => honk.problem('g', null, 'm', { severity: 'BLAST', idempotencyKey: 'k-o' })],
    ];
    for (const [fresh, old] of pairs) {
      const a = await fresh();
      const b = await old();
      assert.deepEqual(b, a);
    }
    assert.equal(s.requests.length, pairs.length * 2);
    for (let i = 0; i < s.requests.length; i += 2) {
      assert.deepEqual(sameRequest(s.requests[i + 1]), sameRequest(s.requests[i]), `pair ${i / 2}`);
    }
    assert.equal(s.requests[2].json.event_type, 'problem');
    assert.equal(s.requests[4].json.event_type, 'recovery');
  });

  test('a test double on send or on honk sees every helper call', async () => {
    for (const name of ['send', 'honk']) {
      const honk = new Honk({ url: 'https://honk.example.com', key: KEY });
      const calls = [];
      honk[name] = async (message, options) => {
        calls.push([message, options]);
        return { id: 'msg_fake', duplicate: false, receivedAt: new Date(0), warnings: [] };
      };
      await honk.uhoh('oven/kitchen', 'The cake is burning', 'smoke', { idempotencyKey: 'k' });
      await honk.problem('oven/kitchen', 'The cake is burning', 'smoke', { idempotencyKey: 'k' });
      await honk.phew('oven/kitchen', 'Cake saved', 'Nobody needs to know.');
      await honk.beep('Someone bought 3 rubber chickens', 'Order 1042');
      assert.equal(calls.length, 4, name);
      assert.deepEqual(calls[0], [{ title: 'The cake is burning', message: 'smoke', severity: 'error', groupKey: 'oven/kitchen', eventType: 'problem' }, { idempotencyKey: 'k', signal: undefined }]);
      assert.deepEqual(calls[1], calls[0]);
      assert.equal(calls[2][0].eventType, 'recovery');
      assert.equal(calls[3][0].severity, 'success');
    }
  });

  test('old and new names fail the same way, without process warnings', async () => {
    const warnings = [];
    const onWarning = (w) => warnings.push(w);
    process.on('warning', onWarning);
    try {
      const honk = new Honk({ url: 'https://honk.example.com', key: KEY });
      for (const call of [() => honk.phew('g', null, ''), () => honk.recovery('g', null, '')]) {
        await assert.rejects(call(), (e) => e instanceof HonkValidationError && e.local && e.fields[0].field === 'message');
      }
      for (const call of [() => honk.honk({}), () => honk.send({})]) {
        await assert.rejects(call(), (e) => e instanceof HonkValidationError && e.fields[0].field === 'message');
      }
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off('warning', onWarning);
    }
    assert.deepEqual(warnings, []);
  });
});

describe('retries and idempotency', () => {
  test('retries 503 then succeeds, reusing the same Idempotency-Key and body', async () => {
    const s = await server([apiError(503, 'unavailable', {}, { 'retry-after': '0' }), apiError(500, 'internal'), ok()]);
    const res = await new Honk({ url: s.url, key: KEY, ...fast }).send({ message: 'x' });
    assert.equal(res.id, 'msg_01k6h3w4z5x6y7z8a9b0c1d2e3');
    assert.equal(s.requests.length, 3);
    const keys = new Set(s.requests.map((r) => r.headers['idempotency-key']));
    assert.equal(keys.size, 1);
    assert.equal(new Set(s.requests.map((r) => r.raw)).size, 1);
  });

  test('retries dropped connections with the same key', async () => {
    const s = await server(['destroy', 'destroy', ok()]);
    await new Honk({ url: s.url, key: KEY, ...fast }).send({ message: 'x' }, { idempotencyKey: 'k-1' });
    assert.equal(s.requests.length, 3);
    assert.deepEqual(s.requests.map((r) => r.headers['idempotency-key']), ['k-1', 'k-1', 'k-1']);
  });

  test('retries a timed-out attempt with the same key', async () => {
    const s = await server([{ ...ok(), delayMs: 400 }, ok()]);
    const res = await new Honk({ url: s.url, key: KEY, timeoutMs: 100, ...fast }).send({ message: 'x' });
    assert.equal(res.duplicate, false);
    assert.equal(s.requests.length, 2);
    assert.equal(s.requests[0].headers['idempotency-key'], s.requests[1].headers['idempotency-key']);
  });

  test('honours Retry-After on 429 rate_limited', async () => {
    const s = await server([apiError(429, 'rate_limited', {}, { 'retry-after': '1' }), ok()]);
    const started = Date.now();
    await new Honk({ url: s.url, key: KEY, ...fast }).send({ message: 'x' });
    assert.ok(Date.now() - started >= 1000, 'waited at least Retry-After');
    assert.ok(s.requests[1].at - s.requests[0].at >= 990);
  });

  test('Retry-After beyond the deadline fails fast with HonkQuotaError', async () => {
    const s = await server(apiError(429, 'quota_exceeded', { limit: 'messages_per_day' }, { 'retry-after': '7200' }));
    const started = Date.now();
    await assert.rejects(new Honk({ url: s.url, key: KEY }).send({ message: 'x' }, { idempotencyKey: 'q-1' }), (e) => {
      assert.ok(e instanceof HonkQuotaError);
      assert.equal(e.kind, 'quota');
      assert.equal(e.code, 'quota_exceeded');
      assert.equal(e.status, 429);
      assert.equal(e.retryAfter, 7200);
      assert.equal(e.attempts, 1);
      assert.equal(e.idempotencyKey, 'q-1');
      assert.equal(e.retryable, true);
      return true;
    });
    assert.ok(Date.now() - started < 1000);
    assert.equal(s.requests.length, 1);
  });

  test('gives up after `retries` with HonkServerError', async () => {
    const s = await server(apiError(503, 'unavailable', {}, { 'retry-after': '0' }));
    await assert.rejects(new Honk({ url: s.url, key: KEY, retries: 2, ...fast }).send({ message: 'x' }), (e) => {
      assert.ok(e instanceof HonkServerError);
      assert.equal(e.code, 'unavailable');
      assert.equal(e.attempts, 3);
      assert.equal(e.requestId, 'req_test');
      return true;
    });
    assert.equal(s.requests.length, 3);
  });

  test('stops at the deadline', async () => {
    const s = await server(apiError(503, 'unavailable', {}, { 'retry-after': '1' }));
    const started = Date.now();
    await assert.rejects(new Honk({ url: s.url, key: KEY, retries: 10, deadlineMs: 1500, ...fast }).send({ message: 'x' }), HonkServerError);
    const took = Date.now() - started;
    assert.ok(took < 1600, `took ${took} ms`);
    assert.equal(s.requests.length, 2);
  });

  test('does not start a retry that could only time out at the deadline', async () => {
    // 200 ms per answer, then a 1 s wait: a retry would have about 100 ms before the deadline.
    const s = await server({ ...apiError(503, 'unavailable', {}, { 'retry-after': '1' }), delayMs: 200 });
    await assert.rejects(new Honk({ url: s.url, key: KEY, retries: 10, deadlineMs: 1300, ...fast }).send({ message: 'x' }), (e) => {
      assert.ok(e instanceof HonkServerError, `got ${e.name}`);
      assert.equal(e.retryAfter, 1);
      return true;
    });
    assert.equal(s.requests.length, 1);
  });

  test('times out with HonkTimeoutError once retries are exhausted', async () => {
    const s = await server({ ...ok(), delayMs: 500 });
    await assert.rejects(new Honk({ url: s.url, key: KEY, timeoutMs: 50, retries: 1, ...fast }).send({ message: 'x' }), (e) => {
      assert.ok(e instanceof HonkTimeoutError);
      assert.ok(e instanceof HonkNetworkError);
      assert.equal(e.kind, 'timeout');
      assert.equal(e.attempts, 2);
      return true;
    });
  });

  test('connection refused becomes HonkNetworkError', async () => {
    const s = await mockServer(ok());
    await s.close();
    await assert.rejects(new Honk({ url: s.url, key: KEY, retries: 1, ...fast }).send({ message: 'x' }), (e) => {
      assert.ok(e instanceof HonkNetworkError);
      assert.equal(e.kind, 'network');
      assert.equal(e.code, 'network_error');
      assert.match(e.idempotencyKey, UUIDV7);
      return true;
    });
  });

  test('an AbortSignal cancels the call', async () => {
    const s = await server({ ...ok(), delayMs: 1000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('stop')), 50);
    await assert.rejects(new Honk({ url: s.url, key: KEY }).send({ message: 'x' }, { signal: ac.signal }), /stop/);
  });
});

describe('error mapping (never retried)', () => {
  const cases = [
    [apiError(422, 'validation_failed', { fields: [{ field: 'severity', code: 'invalid_enum', message: 'must be one of …' }] }), HonkValidationError, 'validation_failed'],
    [apiError(422, 'unknown_field', { fields: [{ field: 'foo', code: 'not_allowed' }] }), HonkValidationError, 'unknown_field'],
    [apiError(413, 'payload_too_large'), HonkValidationError, 'payload_too_large'],
    [apiError(401, 'invalid_key'), HonkAuthError, 'invalid_key'],
    [apiError(403, 'project_suspended'), HonkAuthError, 'project_suspended'],
    [apiError(409, 'idempotency_conflict'), HonkConflictError, 'idempotency_conflict'],
    [apiError(404, 'not_found'), HonkError, 'not_found'],
  ];
  for (const [step, Type, code] of cases) {
    test(`${step.status} ${code} → ${Type.name}`, async () => {
      const s = await server(step);
      await assert.rejects(new Honk({ url: s.url, key: KEY, ...fast }).send({ message: 'x' }), (e) => {
        assert.ok(e instanceof Type, `${e.name}`);
        assert.equal(e.code, code);
        assert.equal(e.status, step.status);
        assert.equal(e.requestId, 'req_test');
        assert.equal(e.attempts, 1);
        assert.equal(e.retryable, false);
        if (Type === HonkValidationError) assert.equal(e.local, false);
        return true;
      });
      assert.equal(s.requests.length, 1);
    });
  }

  test('the error names the code, the server message, every field and the request id', async () => {
    const fields = [
      { field: 'message', code: 'required', message: 'a message or a title is required' },
      { field: 'event_type', code: 'invalid_enum', message: 'must be one of event, problem, recovery' },
    ];
    const s = await server(apiError(422, 'validation_failed', { message: 'The message is invalid', fields }));
    await assert.rejects(new Honk({ url: s.url, key: KEY }).send({ message: 'x', eventType: 'incident' }), (e) => {
      assert.ok(e instanceof HonkValidationError);
      assert.equal(e.local, false);
      assert.equal(e.code, 'validation_failed');
      assert.equal(e.requestId, 'req_test');
      assert.deepEqual(e.fields, fields);
      assert.equal(
        e.message,
        'Honk 422 validation_failed: The message is invalid (message: a message or a title is required; event_type: must be one of event, problem, recovery) [request req_test]',
      );
      return true;
    });
  });

  test('a field error without a message shows its code', async () => {
    const s = await server(apiError(422, 'unknown_field', { message: 'unknown field', fields: [{ field: 'colour', code: 'not_allowed' }] }));
    await assert.rejects(new Honk({ url: s.url, key: KEY }).send({ message: 'x', colour: 'red' }), /\(colour: not_allowed\) \[request req_test\]$/);
    assert.equal(s.requests[0].json.colour, 'red', 'unknown keys are sent for the server to judge');
  });

  test('the request id falls back to the X-Request-Id header', async () => {
    const s = await server({ status: 401, headers: { 'x-request-id': 'req_header' }, body: { error: { code: 'invalid_key', message: 'invalid key' } } });
    await assert.rejects(new Honk({ url: s.url, key: KEY }).send({ message: 'x' }), (e) => {
      assert.ok(e instanceof HonkAuthError);
      assert.equal(e.requestId, 'req_header');
      assert.match(e.message, /\[request req_header\]$/);
      return true;
    });
  });

  test('redirects are not followed', async () => {
    const s = await server({ status: 301, headers: { location: 'https://honk.example.com/v1/messages' }, body: '' });
    await assert.rejects(new Honk({ url: s.url, key: KEY }).send({ message: 'x' }), /redirect to https:\/\/honk\.example\.com/);
    assert.equal(s.requests.length, 1);
  });

  test('non-JSON 502 from a proxy is retried, then reported', async () => {
    const s = await server({ status: 502, headers: { 'content-type': 'text/html' }, body: '<html>Bad Gateway</html>' });
    await assert.rejects(new Honk({ url: s.url, key: KEY, retries: 1, ...fast }).send({ message: 'x' }), (e) => {
      assert.ok(e instanceof HonkServerError);
      assert.equal(e.status, 502);
      assert.equal(e.code, undefined);
      return true;
    });
    assert.equal(s.requests.length, 2);
  });
});

describe('warnings (what the server corrected)', () => {
  const warnings = [
    { field: 'title', code: 'truncated', message: 'longer than 160 characters; shortened' },
    { field: 'actions[1].url', code: 'ignored', message: 'not an https, mailto, tel or sms link; left out' },
    { field: 'priority', code: 'downgraded', message: 'urgent needs a key that allows it; sent as high' },
  ];

  test('are returned on the result, as the server sent them', async () => {
    const s = await server(ok({ warnings }));
    const res = await new Honk({ url: s.url, key: KEY }).honk({ title: 't'.repeat(200), message: 'x', priority: 'urgent' });
    assert.deepEqual(res.warnings, warnings);
    assert.equal(res.id, 'msg_01k6h3w4z5x6y7z8a9b0c1d2e3');
  });

  test('are [] when the server sends none or an older server omits them', async () => {
    const s = await server([ok({ warnings: [] }), ok({ warnings: undefined }), ok({ warnings: 'junk' })]);
    const honk = new Honk({ url: s.url, key: KEY });
    for (let i = 0; i < 3; i++) assert.deepEqual((await honk.honk({ message: 'x' })).warnings, []);
  });

  test('onWarnings is called with the warnings and the result, only when there are some', async () => {
    const s = await server([ok({ warnings }), ok({ warnings: [] })]);
    const calls = [];
    const honk = new Honk({ url: s.url, key: KEY, onWarnings: (w, r) => calls.push([w, r]) });
    const first = await honk.loud('Disk 91%', '/var on app-01');
    await honk.loud('Disk 92%', '/var on app-01');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][0], warnings);
    assert.equal(calls[0][1], first);
  });

  test('a throwing onWarnings does not fail the send', async () => {
    const s = await server(ok({ warnings }));
    const honk = new Honk({
      url: s.url,
      key: KEY,
      onWarnings: () => {
        throw new Error('logger down');
      },
    });
    assert.deepEqual((await honk.honk({ message: 'x' })).warnings, warnings);
  });

  test('a duplicate carries the warnings of the original', async () => {
    const s = await server(ok({ duplicate: true, warnings }));
    const res = await new Honk({ url: s.url, key: KEY }).honk({ message: 'x' }, { idempotencyKey: 'k' });
    assert.equal(res.duplicate, true);
    assert.deepEqual(res.warnings, warnings);
  });

  test('onWarnings must be a function', () => {
    assert.throws(() => new Honk({ url: 'https://h', key: KEY, onWarnings: 'console' }), /onWarnings/);
  });
});

describe('what the SDK still checks', () => {
  const honk = new Honk({ url: 'https://honk.example.com', key: KEY });

  test('a message or a title is required', async () => {
    for (const msg of [{}, { message: '' }, { message: '   ', title: null }, { title: ' ' }, { message: null, title: '' }]) {
      await assert.rejects(honk.send(msg), (e) => {
        assert.ok(e instanceof HonkValidationError, e.message);
        assert.equal(e.local, true);
        assert.equal(e.attempts, 0);
        assert.deepEqual(e.fields.map((f) => `${f.field}:${f.code}`), ['message:required']);
        return true;
      });
    }
  });

  test('a title alone, or a message alone, is sent', async () => {
    const s = await server(ok());
    const client = new Honk({ url: s.url, key: KEY });
    await client.honk({ title: 'Backup finished' });
    await client.honk({ message: 'Backup finished in 42 s' });
    assert.deepEqual(s.requests.map((r) => r.json), [{ title: 'Backup finished' }, { message: 'Backup finished in 42 s' }]);
  });

  test('the body must fit in 16 KiB', async () => {
    const metadata = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, '"'.repeat(500)]));
    await assert.rejects(honk.send({ message: 'x'.repeat(8000), metadata }), (e) => e instanceof HonkValidationError && e.local && e.fields[0].field === 'body' && e.fields[0].code === 'too_long');
  });

  test('field contents are not checked: the server corrects them and says so', async () => {
    const s = await server(ok());
    const msg = {
      message: 'bell\u0007',
      title: 't'.repeat(200),
      severity: 'fatal',
      priority: 'asap',
      category: 'crm',
      eventType: 'recovery',
      sourceSequence: 3,
      url: 'http://example.com',
      imageUrl: 'https://cdn.example.com/a.jpg#x',
      occurredAt: '2026-10-02 10:00',
      metadata: { 'bad key': { nested: 1 } },
      ttlSeconds: 5,
      actions: [{ title: 'Run', url: 'javascript:alert(1)' }, { title: 'Call', url: 'tel:+15550134' }, { title: 'x' }, { title: 'y', url: 'sms:1' }],
    };
    await new Honk({ url: s.url, key: KEY }).honk(msg);
    assert.deepEqual(s.requests[0].json, {
      title: msg.title,
      message: msg.message,
      severity: 'fatal',
      priority: 'asap',
      category: 'crm',
      event_type: 'recovery',
      occurred_at: '2026-10-02 10:00',
      url: 'http://example.com',
      image_url: 'https://cdn.example.com/a.jpg#x',
      actions: msg.actions,
      metadata: msg.metadata,
      ttl_seconds: 5,
      source_sequence: 3,
    });
  });

  test('an invalid Date goes to the server, which leaves it out with a warning', () => {
    assert.equal(buildBody({ message: 'x', occurredAt: new Date('nope') }).occurred_at, 'Invalid Date');
  });

  test('invalid idempotency keys are rejected before sending (fetch could not send them)', async () => {
    for (const key of ['', 'has space', 'x'.repeat(129), 'ünicode', 'line\nbreak']) {
      await assert.rejects(honk.send({ message: 'x' }, { idempotencyKey: key }), (e) => e instanceof HonkValidationError && e.fields[0].field === 'Idempotency-Key');
    }
  });

  test('the old validate option is accepted and ignored', async () => {
    const s = await server(ok());
    await new Honk({ url: s.url, key: KEY, validate: true }).send({ message: 'x', severity: 'fatal' });
    assert.equal(s.requests[0].json.severity, 'fatal');
  });
});

describe('construction', () => {
  test('rejects missing or malformed url/key with a clear message', () => {
    assert.throws(() => new Honk({ url: '', key: KEY }), /url is required.*HONK_URL/);
    assert.throws(() => new Honk({ url: 'honk.example.com', key: KEY }), /must start with https:\/\//);
    assert.throws(() => new Honk({ url: 'https://h', key: undefined }), /key is required.*HONK_KEY/);
    assert.throws(() => new Honk({ url: 'https://h', key: 'hka_mobiletoken' }), /starting with honk_/);
    assert.throws(() => new Honk({ url: 'https://h', key: KEY, retries: -1 }), /retries/);
    assert.throws(() => new Honk({ url: 'https://h', key: KEY, timeoutMs: 0 }), /timeoutMs/);
  });

  test('fromEnv reads HONK_* variables', async () => {
    const s = await server(ok());
    const saved = { ...process.env };
    Object.assign(process.env, { HONK_URL: s.url, HONK_KEY: KEY, HONK_SOURCE: 'cron', HONK_ENVIRONMENT: 'staging' });
    try {
      const honk = Honk.fromEnv();
      await honk.send({ message: 'x' });
      assert.deepEqual(s.requests[0].json, { message: 'x', source: 'cron', environment: 'staging' });
    } finally {
      for (const k of ['HONK_URL', 'HONK_KEY', 'HONK_SOURCE', 'HONK_ENVIRONMENT']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  test('VERSION matches package.json', () => {
    assert.equal(VERSION, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  });
});

describe('helpers', () => {
  test('uuidv7 is version 7, variant 10, time-ordered', async () => {
    const a = await uuidv7(1_700_000_000_000);
    const b = await uuidv7(1_700_000_000_001);
    assert.match(a, UUIDV7);
    assert.ok(a < b);
    assert.equal(a.slice(0, 13).replace('-', ''), (1_700_000_000_000).toString(16).padStart(12, '0'));
  });

  const isBun = typeof globalThis.Bun !== 'undefined';
  test('uuidv7 works without a global crypto (Node 18)', { skip: isBun && 'Bun always has Web Crypto' }, async () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); // Node 18: inherited, no own property
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    try {
      assert.match(await uuidv7(), UUIDV7);
    } finally {
      if (desc) Object.defineProperty(globalThis, 'crypto', desc);
      else delete globalThis.crypto;
    }
  });

  test('parseRetryAfter handles seconds and HTTP dates', () => {
    assert.equal(parseRetryAfter('3'), 3);
    assert.equal(parseRetryAfter(' 120 '), 120);
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter('soon'), undefined);
    const now = Date.parse('2026-10-02T10:00:00Z');
    assert.equal(parseRetryAfter('Fri, 02 Oct 2026 10:00:30 GMT', now), 30);
    assert.equal(parseRetryAfter('Fri, 02 Oct 2026 09:00:00 GMT', now), 0);
  });
});
