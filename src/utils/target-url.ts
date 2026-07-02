/**
 * Normalize and validate a brand website URL passed from the harness or CLI.
 */
export function normalizeTargetUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error('targetUrl is required');
  }

  const withProtocol = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withProtocol).toString().replace(/\/$/, '');
  } catch {
    throw new Error(`Invalid targetUrl: ${url}`);
  }
}

export function parseTargetUrlFromArgv(argv: string[] = process.argv): string {
  const idx = argv.indexOf('--url');
  if (idx !== -1 && argv[idx + 1]) {
    return normalizeTargetUrl(argv[idx + 1]!);
  }
  throw new Error('Missing --url (e.g. npm run demo -- --url https://example.com)');
}

export function hostnameFromUrl(url: string): string {
  try {
    return new URL(normalizeTargetUrl(url)).hostname.replace(/^www\./, '');
  } catch {
    return url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  }
}
