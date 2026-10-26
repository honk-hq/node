import { HonkValidationError } from './errors.js';
import { normalizeSeverity, type Defaults, type Message } from './types.js';

/**
 * The few limits the SDK checks itself. Everything else (lengths, links, actions, metadata, enums)
 * is the server's job: it corrects what it can and reports it in `SendResult.warnings`.
 */
export const LIMITS = {
  /** The server refuses larger bodies (`413 payload_too_large`). */
  bodyBytes: 16 * 1024,
  /** An Idempotency-Key is 1–128 printable ASCII characters. */
  idempotencyKey: 128,
} as const;

// camelCase SDK field → snake_case wire field, in a stable order.
const FIELDS = {
  title: 'title',
  message: 'message',
  severity: 'severity',
  priority: 'priority',
  category: 'category',
  source: 'source',
  environment: 'environment',
  channel: 'channel',
  groupKey: 'group_key',
  eventType: 'event_type',
  occurredAt: 'occurred_at',
  url: 'url',
  imageUrl: 'image_url',
  actions: 'actions',
  metadata: 'metadata',
  ttlSeconds: 'ttl_seconds',
  sourceSequence: 'source_sequence',
} as const satisfies Record<keyof Message, string>;

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;
const encoder = new TextEncoder();
const isBlank = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/**
 * Checks an Idempotency-Key: 1–128 printable ASCII characters (0x21–0x7E). Checked before sending
 * because a header `fetch` cannot send would otherwise look like a network error.
 */
export function checkIdempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) {
    throw new HonkValidationError(
      'Invalid idempotency key: use 1–128 printable ASCII characters without spaces, e.g. "request-4812"',
      { local: true, code: 'validation_failed', fields: [{ field: 'Idempotency-Key', code: 'invalid_format', message: '1-128 printable ASCII characters' }] },
    );
  }
  return key;
}

/**
 * Turns a message into the wire object of `POST /v1/messages`: snake_case names, the client
 * `defaults`, horn aliases sent canonical, a `Date` as RFC 3339. Empty optional fields are left
 * out. Only two things are checked here: a `message` or a `title` is present, and the JSON body
 * is at most 16 KiB. Keys this SDK does not know are sent as given, for the server to judge.
 */
export function buildBody(input: Message, defaults: Defaults = {}): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw local('Invalid Honk message: expected an object like { title, message }', 'body', 'invalid_format', 'must be an object');
  }
  const msg = input as unknown as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const [name, wire] of Object.entries(FIELDS) as [keyof Message, string][]) {
    let v = msg[name];
    if (isBlank(v) && (name === 'source' || name === 'environment' || name === 'channel')) v = defaults[name];
    if (v === undefined || v === null || v === '' || (name === 'actions' && Array.isArray(v) && v.length === 0)) continue;
    if (v instanceof Date) v = Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
    // Horn aliases (any case) are sent canonical; anything else is the server's to judge.
    if (name === 'severity' && typeof v === 'string') v = normalizeSeverity(v) ?? v;
    body[wire] = v;
  }
  for (const key of Object.keys(msg)) {
    if (!(key in FIELDS) && !(key in body) && msg[key] !== undefined) body[key] = msg[key];
  }

  if (isBlank(body.message) && isBlank(body.title)) {
    throw local('Invalid Honk message: set a message or a title', 'message', 'required', 'a message or a title is required');
  }
  const size = encoder.encode(JSON.stringify(body)).length;
  if (size > LIMITS.bodyBytes) {
    throw local(`Invalid Honk message: the JSON body is ${size} bytes; Honk accepts at most 16 KiB`, 'body', 'too_long', `${size} bytes, at most 16 KiB`);
  }
  return body;
}

function local(text: string, field: string, code: string, message: string): HonkValidationError {
  return new HonkValidationError(text, { local: true, code: 'validation_failed', fields: [{ field, code, message }] });
}
