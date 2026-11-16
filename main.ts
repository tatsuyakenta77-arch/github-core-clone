// main.ts — the entrypoint: bind an ephemeral port, register it with the trial
// environment, then poll until the environment reports done. The server itself
// lives in app.ts; this file only owns the lifecycle the harness expects.

import { createApp } from './app.ts';

const REGISTER_INITIAL_DELAY_MS = 250;
const REGISTER_MAX_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<number> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    console.error('MAKEFUN_ENV_URL is not set; refusing to start outside a trial.');
    return 1;
  }
  const base = envUrl.replace(/\/+$/, '');

  const { server } = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address !== null && typeof address === 'object') resolve(address.port);
      else reject(new Error('the server bound no port'));
    });
  });

  // Register the port; the environment dials the peer address it sees, so the
  // body carries only the port. 200 or 409 (first register wins) both count.
  let delay = REGISTER_INITIAL_DELAY_MS;
  for (;;) {
    try {
      const response = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) break;
      if (response.status === 400 || response.status === 405) {
        console.error(`registration refused with HTTP ${response.status}; exiting.`);
        server.close();
        return 1;
      }
      console.error(`registration answered HTTP ${response.status}; retrying.`);
    } catch (err) {
      console.error(`registration failed (${err instanceof Error ? err.message : String(err)}); retrying.`);
    }
    await sleep(delay);
    delay = Math.min(REGISTER_MAX_DELAY_MS, delay * 2);
  }

  // Poll until the environment reports done; never hold a request open, never exit early.
  delay = REGISTER_INITIAL_DELAY_MS;
  for (;;) {
    try {
      const response = await fetch(`${base}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) break;
      } else {
        console.error(`done poll answered HTTP ${response.status}; retrying.`);
      }
    } catch (err) {
      console.error(`done poll failed (${err instanceof Error ? err.message : String(err)}); retrying.`);
    }
    await sleep(delay);
    delay = Math.min(REGISTER_MAX_DELAY_MS, delay * 2);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  return 0;
}

process.exitCode = await main();
