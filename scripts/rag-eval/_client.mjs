// Shared Base44 client builder for the (write-capable) eval scripts.
// Requires an ADMIN token so it can create Clients/Trainings and delete
// fixture rows. Nothing here runs unless the caller has passed the explicit
// acknowledgement flag AND supplied credentials.

import { createClient } from '@base44/sdk';

export const EVAL_PREFIX = 'ZZ_RAGEVAL_';
export const ACK_FLAG = '--i-understand-this-writes-to-base44';

export function requireAckOrExit(argv) {
  if (!argv.includes(ACK_FLAG)) {
    console.error(
      `\nThis script WRITES to a live Base44 environment.\n` +
        `Re-run with ${ACK_FLAG} once you have explicit approval to do so.\n`,
    );
    process.exit(2);
  }
}

export function buildClient() {
  const appId = process.env.BASE44_APP_ID;
  const token = process.env.BASE44_TOKEN || process.env.BASE44_API_KEY;
  const appBaseUrl = process.env.BASE44_APP_BASE_URL;
  if (!appId || !token) {
    console.error(
      '\nSet BASE44_APP_ID and BASE44_TOKEN (admin token) in the environment first.\n' +
        'Optionally set BASE44_APP_BASE_URL. Prefer a non-production Base44 app.\n',
    );
    process.exit(2);
  }
  return createClient({ appId, token, appBaseUrl, requiresAuth: true });
}

// A record is a deletable eval fixture only if it is explicitly marked.
export function isEvalFixture(rec) {
  return (
    rec?.is_eval_fixture === true ||
    (typeof rec?.name === 'string' && rec.name.startsWith(EVAL_PREFIX)) ||
    (typeof rec?.title === 'string' && rec.title.startsWith(EVAL_PREFIX))
  );
}
