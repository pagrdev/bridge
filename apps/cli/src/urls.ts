import type { BridgeConfig } from '@pagr/bridge-core';

export const PROD_API_URL = 'https://api.pagr.dev';
export const PROD_WEB_URL = 'https://app.pagr.dev';
export const DEV_API_URL = 'http://localhost:4000';
export const DEV_WEB_URL = 'http://localhost:3000';

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
  return (configuredApiUrl(env, flag, config) ?? (isDev(env) ? DEV_API_URL : PROD_API_URL)).replace(
    /\/$/,
    '',
  );
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
  return isDev(env) ? DEV_WEB_URL : PROD_WEB_URL;
}
