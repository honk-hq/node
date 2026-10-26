# honk-honk

[![CI](https://github.com/honk-hq/node/actions/workflows/ci.yml/badge.svg)](https://github.com/honk-hq/node/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/honk-honk)](https://www.npmjs.com/package/honk-honk)

Official Node.js / TypeScript client for [Honk! Honk!](https://honk-honk.app), the inbox that turns
events from your apps, scripts, cron jobs and CI into calm, grouped push notifications on your
phone.

```js
import { Honk } from 'honk-honk';

const honk = Honk.fromEnv(); // HONK_URL and HONK_KEY

await honk.uhoh('oven/kitchen', 'The cake is burning', 'Oven at 260 °C. The smoke alarm agrees.');
// …a few tense minutes later
await honk.phew('oven/kitchen', 'Cake saved', 'Nobody needs to know.');

await honk.honk({ title: 'Someone bought 3 rubber chickens', message: 'Order 1042, €2.97', severity: 'beep' });
```

`uhoh` opens an incident for `oven/kitchen` and your phone honks. If the oven keeps
complaining, the same notification is updated instead of honking again. `phew` closes the
incident, and `honk` sends anything else. Until 0.3.0 these were `send()`, `problem()` and
`recovery()`; the old names still work and send exactly the same request.

- Zero runtime dependencies. ESM, CommonJS and TypeScript types.
- Node 18+ (global `fetch`). Also works on Bun and Deno (`npm:honk-honk`).
- Retries with backoff, `Retry-After`, a total deadline and an idempotency key on every send,
  so a retry never creates a duplicate.

> **Keep the key on the server.** A Honk! Honk! ingestion key (`honk_…`) lets anyone post into your
> project. Use this package in back-end code, functions and scripts only. Never bundle it
> into a browser, mobile or desktop front end, and never commit it. Read it from the
> environment.

## Install

```sh
npm install honk-honk
```

Create a project and an ingestion key at [honk-honk.app](https://honk-honk.app). Its
*Integrations* page generates ready-to-paste code for this package.

## Quick start

```js
import { Honk } from 'honk-honk';

const honk = new Honk({ url: process.env.HONK_URL, key: process.env.HONK_KEY });
await honk.beep('Backup finished', 'nightly pg_dump took 42 s');
```

`Honk.fromEnv()` reads `HONK_URL`, `HONK_KEY` and the optional `HONK_SOURCE`,
`HONK_ENVIRONMENT` and `HONK_CHANNEL` defaults. CommonJS:
`const { Honk } = require('honk-honk')`.

## Sending

```ts
honk.honk(message, { idempotencyKey?, signal? }) // → Promise<{ id, duplicate, receivedAt, warnings }>
```

The essentials:

| Field | Notes |
|---|---|
| `message` | the text; line breaks are kept |
| `title` | one line; without it, the first line of `message`. A message needs a `message`, a `title` or both |
| `severity` | the level (below). It alone decides how loudly the phone honks |
| `groupKey` | messages with the same key form one group: the first pushes, repeats update it calmly. Without a key, messages group by their title |
| `eventType` | `problem` opens an incident for the group, `recovery` closes it; `uhoh()` and `phew()` set it for you |

Also accepted, and sent as the API's snake_case names: `priority`, `category`, `source`,
`environment`, `channel` (the last three default to the client's `defaults`), `occurredAt`
(a `Date` or an RFC 3339 string), `url`, `imageUrl`, `actions` (up to 3 buttons
`{ title, url }`), `metadata`, `ttlSeconds` and `sourceSequence` (their types document them).

The SDK does not check field contents. It sends what you give it, and the server **delivers
first**: what is too long is shortened, an invalid optional value is left out, and the message is
stored anyway. What it corrected comes back in `warnings` (see below). The SDK itself refuses
only a message with neither a `message` nor a `title`, and a body over 16 KiB.

A resolved promise means Honk! Honk! **durably stored** the message (`202`); it does not mean a
push was delivered or read.

## The Honk scale

Five levels. The Honk app shows them by their standard names (Info, Success, Warning, Error,
Critical); people who prefer horn sounds can switch on the Honk names (Light, Beep, Loud, Long,
Blast) with the "Honk names for levels" switch in Settings. The SDK takes both, in any case, and
sends the canonical value.

| Level | Honk name | Severity | Helper | Constant |
|---|---|---|---|---|
| Info | Light | `light` (info) | `honk.light(title, message, opts)` | `Severity.Light` |
| Success | Beep | `beep` (success) | `honk.beep(…)` | `Severity.Beep` |
| Warning | Loud | `loud` (warning) | `honk.loud(…)` | `Severity.Loud` |
| Error | Long | `long` (error) | `honk.long(…)` | `Severity.Long` |
| Critical | Blast | `blast` (critical) | `honk.blast(…)` | `Severity.Blast` |

`severity: 'loud'`, `'LOUD'` and `'warning'` are the same event (also for idempotency).
`info()`, `success()`, `warning()`, `error()` and `critical()` remain as synonyms;
`normalizeSeverity('Blast') === 'critical'`.

## Problems and recoveries

```js
await honk.uhoh('db/backup', 'Backup failed', 'pg_dump exited with 1');   // event_type problem, a Long message by default
await honk.phew('db/backup', 'Backup OK', 'pg_dump finished in 41 s');    // event_type recovery, a Beep message by default
```

`uhoh` opens an incident for its group key and pushes; repeats update the same notification
calmly. `phew` closes it. The last argument of every helper takes any message field plus
`idempotencyKey` and `signal`:

```js
await honk.loud('Disk 91%', '/var on app-01', { groupKey: 'disk/app-01/var' });
await honk.light('Deploy started', 'v4.2.0 to production', { channel: 'deploys' });
```

## Warnings: what the server corrected

```js
const res = await honk.honk({ title: veryLongTitle, message: 'x', actions });
res.warnings;
// [{ field: 'title', code: 'truncated', message: '…' },
//  { field: 'actions[1].url', code: 'ignored', message: '…' }]
```

Each warning has the wire `field` (`title`, `metadata.order`, `actions[1].url`), a `code`
(`truncated`, `normalized`, `ignored`, `clamped`, `downgraded`, `hashed`) and an English
`message`. They are never errors: the message was stored. They show what to fix in the code that
sends it. To log them in one place, pass `onWarnings`:

```js
const honk = Honk.fromEnv({ onWarnings: (warnings, result) => console.warn(`honk ${result.id}:`, warnings) });
```

## Recipe: notify me when a customer asks for something

Give each request its own group (`requests/<id>`) and its own idempotency key. Two different
customers never fold into one notification, and a retried webhook or job never buzzes twice.

```js
import { Honk } from 'honk-honk';

const honk = Honk.fromEnv(); // create once, reuse (keep-alive)

export async function onCustomerRequest(req) {
  // ...save the request first, then notify without blocking the response:
  honk
    .honk(
      {
        title: `New request: ${req.subject}`,
        message: `${req.name} (${req.company}) asked: ${req.body}`, // the server shortens what is too long
        severity: 'loud',
        groupKey: `requests/${req.id}`, // one group per request
        url: `https://shop.example.com/admin/requests/${req.id}`, // shown as "Open link"
        actions: [{ title: 'Reply', url: `mailto:${req.email}` }],
      },
      { idempotencyKey: `request-${req.id}` }, // same request, same key: never a duplicate
    )
    .catch((err) => console.warn('honk:', err.message)); // never fail the customer's request
}
```

In a queue worker (BullMQ, SQS, …) `await` the call and let the job retry on
`err.retryable`, keeping the same `idempotencyKey`.

## Options

```js
new Honk({
  url: 'https://honk.example.com', // base URL of your server
  key: 'honk_…',                  // project ingestion key
  timeoutMs: 5000,                // per attempt
  retries: 4,                     // after the first attempt
  deadlineMs: 30000,              // total, waits included
  defaults: { source: 'billing-api', environment: 'production', channel: 'payments' },
  onWarnings: (warnings, result) => logger.warn({ id: result.id, warnings }),
  backoff: { baseMs: 500, maxMs: 8000 },
  fetch: customFetch,             // e.g. undici with a proxy agent
});
```

## Retries and idempotency, guaranteed

- Every `honk()` (and every helper) carries an `Idempotency-Key`: yours, or a fresh UUIDv7. **The same key is
  reused on every retry.** Within 24 h Honk! Honk! answers a replay with the original id and
  `duplicate: true`, so a lost response never creates a second message.
- Only network errors, timeouts, `429` and `5xx` are retried, with exponential backoff and
  full jitter (`random(0, min(8 s, 0.5 s·2ⁿ))`), never sooner than the server's `Retry-After`.
- Everything stops at `deadlineMs`: if the next wait, plus time for one more attempt, would
  cross it (for example a daily quota that resets at midnight), the error is thrown at once
  with `retryAfter`.
- `4xx` other than `429` are never retried: fix the request instead.
- Short per-attempt timeouts; Node's `fetch` keeps connections alive, so create one `Honk`
  per process and reuse it.
- Pass your own stable key (`request-4812`, `deploy-${sha}`) to stay duplicate-free across
  process restarts and job retries. Reusing a key with a *different* payload is a conflict.

## Errors

Every error is a `HonkError` with `kind`, `status`, `code`, `requestId`, `idempotencyKey`,
`attempts`, `retryAfter` and `retryable`. Its `message` carries the server's code, message, every
field problem and the request id, e.g.
`Honk 422 validation_failed: … (event_type: must be one of event, problem, recovery) [request req_01k6…]`.

| Class | `kind` | When | What to do |
|---|---|---|---|
| `HonkValidationError` | `validation` | refused by the server (`400`/`413`/`415`/`422`: neither message nor title, an unknown top-level field, an invalid `eventType`, invalid JSON, over 16 KiB); `fields` names each problem. `local: true` when the SDK refused it before sending | fix the message |
| `HonkAuthError` | `auth` | `401 invalid_key`, `403 project_suspended`, `workspace_suspended` | fix the key |
| `HonkQuotaError` | `quota` | `429 quota_exceeded` (daily, resets at UTC midnight) or `rate_limited`, after retries | retry after `retryAfter` seconds |
| `HonkConflictError` | `conflict` | `409 idempotency_conflict`: same key, different payload | use a new key, or send the original payload |
| `HonkNetworkError` | `network` | unreachable on every attempt | retry later, same key |
| `HonkTimeoutError` | `timeout` | attempts timed out; the message may or may not be stored | retry later, same key |
| `HonkServerError` | `server` | `5xx` on every attempt | retry later, same key |

```js
import { HonkError, HonkValidationError } from 'honk-honk';

try {
  await honk.honk(msg, { idempotencyKey: `order-${order.id}-failed` });
} catch (err) {
  if (err instanceof HonkValidationError) logger.error(err.fields);   // a bug: don't retry
  else if (err instanceof HonkError && err.retryable) queue.retryLater(err.idempotencyKey, err.retryAfter);
  else throw err;
}
```

`kind` is also handy when two copies of the package are loaded and `instanceof` can fail.

## Bun and Deno

```ts
import { Honk } from 'npm:honk-honk'; // Deno
const honk = new Honk({ url: Deno.env.get('HONK_URL')!, key: Deno.env.get('HONK_KEY')! });
```

Bun: `bun add honk-honk`, then use it as in Node.

## Development

```sh
npm install
npm test                 # build + unit tests (mock server) + CommonJS smoke test
npm run typecheck        # also checks the published .d.ts from ESM and CJS consumers
HONK_URL=… HONK_KEY=… npm run test:integration   # against a real server (use a test project's key)
```

The version lives in `package.json`; the build regenerates `src/version.ts` (`VERSION`, the
User-Agent) from it. Releases: push a tag `vX.Y.Z` matching `package.json` and the release
workflow publishes to npm with provenance (see `CHANGELOG.md`).

## Links

- [honk-honk.app](https://honk-honk.app): the Honk! Honk! inbox (web, iPhone, Apple Watch).
- From a shell, cron or CI: the `honk` CLI in [honk-go](https://github.com/honk-hq/go)
  (`honk uhoh backup/db-1 "Backup failed" "Exit code 1"`).
- Other SDKs: [PHP / Laravel](https://github.com/honk-hq/php),
  [Go + CLI](https://github.com/honk-hq/go), [Swift](https://github.com/honk-hq/honk-swift),
  [Kotlin / Java](https://github.com/honk-hq/kotlin), [Rust](https://github.com/honk-hq/rust).
- No code: [n8n node](https://github.com/honk-hq/n8n) (`n8n-nodes-honk`) and the
  [WordPress plugin](https://github.com/honk-hq/wordpress).

MIT License.
