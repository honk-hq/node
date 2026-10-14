// Compile-only checks of the public types (ESM consumer). Not executed.
import { Honk, HonkError, HonkQuotaError, Severity, type Action, type Message, type SendResult } from 'honk-me';

const honk = new Honk({ url: 'https://honk.example.com', key: 'honk_x', defaults: { source: 'api' } });
const msg: Message = { message: 'x', severity: 'error', groupKey: 'g', metadata: { a: 1, b: 'c', d: true } };
const res: Promise<SendResult> = honk.send(msg, { idempotencyKey: 'k' });
void res;
void honk.problem('g', 't', 'm', { url: 'https://x', idempotencyKey: 'k' });
const honked: Promise<SendResult> = honk.honk(msg, { idempotencyKey: 'k' });
void honked;
const uhoh: Promise<SendResult> = honk.uhoh('oven/kitchen', 'The cake is burning', 'Oven at 260 °C', { severity: 'blast', idempotencyKey: 'k' });
const phew: Promise<SendResult> = honk.phew('oven/kitchen', null, 'Cake saved. Nobody needs to know.', { sourceSequence: 2 });
void uhoh;
void phew;
// The old names keep the exact same signatures as the new ones.
const sameSend: typeof honk.honk = honk.send;
const sameProblem: typeof honk.uhoh = honk.problem;
const sameRecovery: typeof honk.phew = honk.recovery;
void sameSend;
void sameProblem;
void sameRecovery;
// @ts-expect-error uhoh needs a group key, a title (or null) and a message
void honk.uhoh('The cake is burning');
const horns: Message[] = [{ message: 'x', severity: 'loud' }, { message: 'x', severity: 'BLAST' }, { message: 'x', severity: Severity.Long }];
const canonical: Severity = Severity.Beep;
void horns;
void canonical;
void honk.loud('Disk 91%', '/var on app-01');
// @ts-expect-error severity is an enum
const bad: Message = { message: 'x', severity: 'fatal' };
void bad;
const actions: Action[] = [{ title: 'Reply', url: 'mailto:emily@example.com' }, { title: 'Call', url: 'tel:+15550134' }];
void honk.send({ message: 'Emily asked for a quote', actions });
void honk.loud('Disk 91%', '/var', { actions: [{ title: 'Open', url: 'https://x' }] as const });
// @ts-expect-error an action needs a url
const noUrl: Message = { message: 'x', actions: [{ title: 'Call' }] };
void noUrl;
try {
  await honk.info('t', 'm');
} catch (e) {
  if (e instanceof HonkQuotaError) e.retryAfter?.toFixed();
  if (e instanceof HonkError && e.kind === 'timeout') e.idempotencyKey?.length;
}
