import type { BridgeConfig } from '@pagr/bridge-core';
import { CliError, EXIT } from './errors.js';

/**
 * The hosted deployment this build points at when the user has not chosen one.
 *
 * Both are deliberately `null`: Stagberry Labs does not own a production domain yet, and the
 * previous values (`api.pagr.dev` / `app.pagr.dev`) belong to an unrelated company. A published
 * CLI carrying them would have sent every customer's pairing request — device name, public key,
 * platform — to a stranger's server. Failing loudly is the only safe default until the domain
 * exists.
 *
 * To point this build at a deployment, set BOTH constants here and nothing else: every other
 * module resolves through `resolveApiUrl` / `resolveWebUrl`. Until then users pass `--api-url`
 * or `PAGR_API_URL`, which has always taken precedence anyway.
 */
export const PROD_API_URL: string | null = null;
export const PROD_WEB_URL: string | null = null;
export const DEV_API_URL = 'http://localhost:4000';
export const DEV_WEB_URL = 'http://localhost:3000';

/** Raised instead of silently contacting a host nobody chose. */
export const noApiUrlError = (): CliError =>
  new CliError('no Pagr API URL is configured', EXIT.usage, {
    code: 'no_api_url',
    hint: 'pass `--api-url https://<your-pagr-api>` or set `PAGR_API_URL`',
    detail:
      'this build has no default hosted API. Ask whoever runs your Pagr deployment for its URL.',
  });

export const isDev = (env: NodeJS.ProcessEnv): boolean =>
  env.PAGR_ENV === 'development' || env.NODE_ENV === 'development' || env.PAGR_DEV === '1';

/**
 * The API URL only if somebody actually chose one: `--api-url` → `PAGR_API_URL` → `config.json`
 * (written by `pagr connect`). `null` means we would be falling back to the compiled-in default,
 * i.e. this machine has never been paired and nobody has pointed it at a stack.
 *
 * `pagr doctor` needs that distinction: failing a network probe against a host the user never
 * asked for turns a fresh, correct install into a red report.
 */
export function configuredApiUrl(
  env: NodeJS.ProcessEnv,
  flag?: string,
  config?: BridgeConfig,
): string | null {
  const chosen = flag || env.PAGR_API_URL || config?.apiUrl;
  return chosen ? chosen.replace(/\/$/, '') : null;
}

/** `--api-url` → `PAGR_API_URL` → config → dev/prod default. */
export function resolveApiUrl(
  env: NodeJS.ProcessEnv,
  flag?: string,
  config?: BridgeConfig,
): string {
  const chosen = configuredApiUrl(env, flag, config) ?? (isDev(env) ? DEV_API_URL : PROD_API_URL);
  if (!chosen) throw noApiUrlError();
  return chosen.replace(/\/$/, '');
}

/**
 * The dashboard URL. `config.json` has no `webUrl` field (core owns that schema), so derive it:
 * `--web-url` → `PAGR_WEB_URL` → sibling of the API host → dev/prod default.
 */
export function resolveWebUrl(
  env: NodeJS.ProcessEnv,
  config?: BridgeConfig,
  flag?: string,
): string {
  if (flag) return flag.replace(/\/$/, '');
  if (env.PAGR_WEB_URL) return env.PAGR_WEB_URL.replace(/\/$/, '');
  const api = config?.apiUrl ?? env.PAGR_API_URL;
  if (api) {
    try {
      const u = new URL(api);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return DEV_WEB_URL;
      if (u.hostname.startsWith('api.')) return `${u.protocol}//app.${u.hostname.slice(4)}`;
    } catch {
      // fall through
    }
  }
  const fallback = isDev(env) ? DEV_WEB_URL : PROD_WEB_URL;
  if (!fallback) throw noApiUrlError();
  return fallback;
}

/**
 * `resolveWebUrl`, but `null` instead of throwing when no dashboard URL can be worked out.
 *
 * For places where the URL is a courtesy rather than the point of the command — `pagr logout`
 * naming the page where you can also revoke the device, for instance. Those must still do their
 * real work on a machine that was never pointed at a deployment.
 */
export function tryResolveWebUrl(
  env: NodeJS.ProcessEnv,
  config?: BridgeConfig,
  flag?: string,
): string | null {
  try {
    return resolveWebUrl(env, config, flag);
  } catch {
    return null;
  }
}
