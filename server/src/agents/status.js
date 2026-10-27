// Separate identity and quota probes: a ChatGPT/Codex account is NOT the
// Anthropic account and must not mutate its quota hold or login cards.
import { run } from '../exec.js';
import { CodexAppServer } from './app-server.js';

export const agentStatusHooks = {
  run: (name, args, options) => run(name, args, options),
  client: () => new CodexAppServer(),
};

export async function codexCliStatus() {
  const version = await agentStatusHooks.run('codex', ['--version'], { timeoutMs: 8_000 })
    .catch((e) => ({ ok: false, stderr: e.message }));
  if (!version?.ok) return { installed: false, authenticated: false, version: null };
  const auth = await agentStatusHooks.run('codex', ['login', 'status'], { timeoutMs: 8_000 })
    .catch(() => ({ ok: false }));
  // No stdout from "login status" is returned to the browser: it can contain
  // account details. Only the boolean and CLI version are shared.
  return {
    installed: true,
    authenticated: Boolean(auth?.ok),
    version: String(version.stdout ?? '').trim().slice(0, 70),
  };
}

/** App Server's native rate limit read, without touching Anthropic quota. */
export async function codexLimits() {
  const client = agentStatusHooks.client();
  try {
    await client.open();
    const limits = await client.request('account/rateLimits/read', {}, { timeoutMs: 10_000 });
    return { ok: true, limits };
  } catch (e) {
    return { ok: false, error: e.message, limits: null };
  } finally {
    client.close();
  }
}

export function providerCapabilities() {
  return {
    claude: {
      batch: true, chat: true, hooks: true, interactiveApprovals: true,
      browserQa: true, remoteRunner: true, autoUpgrade: true,
    },
    codex: {
      batch: true, chat: true, resume: true, fork: true,
      stream: true, interactiveApprovals: true, steer: true,
      browserQa: false, remoteRunner: false, autoUpgrade: false,
    },
  };
}
