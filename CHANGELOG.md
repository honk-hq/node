# Changelog

All notable changes to `honk-honk` (npm) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

The SDK is now a thin wrapper: the server "delivers first" (it corrects what it can and accepts
the message), so the SDK no longer second-guesses it.

### Added
- `SendResult.warnings`: what the server corrected in an accepted message, as
  `{ field, code, message }` (`HonkWarning`; codes `truncated`, `normalized`, `ignored`,
  `clamped`, `downgraded`, `hashed`). `[]` when nothing, and from servers that send none.
- `onWarnings(warnings, result)` option: called after every send the server accepted with
  corrections, for logging in one place. An exception thrown in it is ignored.
- A message may have only a `title` (`message` is now optional in `Message`); one of the two is
  required.

### Changed
- Error messages name the server's code and message, every field problem and the request id:
  `Honk 422 validation_failed: … (event_type: must be one of …) [request req_…]`.
- Keys of a message object that the SDK does not know are sent as given, for the server to
  judge (it answers `422 unknown_field`), instead of being refused locally.
- An invalid `Date` in `occurredAt` is sent as is (the server leaves it out with a warning)
  instead of being refused.

### Removed
- Local checks of field contents: lengths, control characters, enums, URLs, actions, metadata,
  `ttlSeconds`, `sourceSequence` and the group-key rules. The SDK refuses only a message with
  neither a message nor a title, a body over 16 KiB and an invalid `Idempotency-Key` (a header
  `fetch` could not send).
- The `validate` option is accepted and ignored (deprecated), and `Honk#validate` is gone.
- `LIMITS` keeps only `bodyBytes` and `idempotencyKey`.
- `priority_not_allowed` is no longer documented: the server lowers `urgent` to `high` with a
  `downgraded` warning instead.

## [0.4.1] - 2026-10-18

### Changed
- The README and the npm description and author call the product Honk! Honk!; the package
  and its API are unchanged.

## [0.4.0] - 2026-10-15

### Changed
- The package is now `honk-honk` on npm.

## [0.3.0] - 2026-10-14

### Added
- New names for the three main calls, with the same arguments and results:
  `honk.honk(message, options)` (was `send`), `honk.uhoh(groupKey, title, message, options)`
  (was `problem`) and `honk.phew(groupKey, title, message, options)` (was `recovery`).

### Changed
- `send()`, `problem()` and `recovery()` are now aliases of `honk()`, `uhoh()` and `phew()`.
  They are not deprecated, print no warnings and send byte-for-byte the same request, so
  existing code needs no change.
- README and JSDoc use the new names. The package is still `honk-me` on npm.

## [0.2.0] - 2026-10-07

### Added
- `actions`: up to 3 buttons on a message, `{ title, url }` with an `https://`, `mailto:`,
  `tel:` or `sms:` URL (the `Action` type). Validated locally like the server does, with
  errors named `actions[1].url`; empty `actions` are omitted, so messages without buttons are
  sent exactly as before.

## [0.1.1] - 2026-10-06

### Fixed
- Near the deadline, a retry no longer starts with only a few milliseconds left. Such an
  attempt could only time out, and its `HonkTimeoutError` hid the server's real answer (for
  example `503`). A retry now needs at least 250 ms (or `timeoutMs`, when shorter) before
  `deadlineMs`; otherwise the last error is thrown at once.

### Changed
- Package author: Honk <accounts@honk-me.app>. The README links the Rust SDK, the n8n node
  and the WordPress plugin.

## [0.1.0] - 2026-10-04

### Added
- `Honk` client for `POST /v1/messages` with every field of the v1 ingestion API
  (including `imageUrl`), camelCase in, snake_case on the wire.
- Automatic UUIDv7 `Idempotency-Key` (or your own), reused on every retry.
- Retries for network errors, timeouts, 429 and 5xx with exponential backoff, full jitter,
  `Retry-After` and a total deadline.
- Typed errors: `HonkValidationError`, `HonkAuthError`, `HonkQuotaError`,
  `HonkConflictError`, `HonkNetworkError`, `HonkTimeoutError`, `HonkServerError`.
- Local validation of limits, enums and https-only URLs, with every invalid field reported.
- Helpers `problem`, `recovery`, `info`, `success`, `warning`, `error`, `critical`;
  `Honk.fromEnv()`.
- ESM + CommonJS builds with TypeScript types, zero runtime dependencies; Node 18+, Bun, Deno.
- The Honk scale: severity horn aliases `light` (info), `beep` (success), `loud` (warning),
  `long` (error), `blast` (critical), case-insensitive and always sent canonical; `Severity`
  constants (`Severity.Loud === 'warning'`), `normalizeSeverity()` and the `light`, `beep`,
  `loud`, `long`, `blast` helpers.
