import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Credentials and scheme of an {@link RtspAuth}.
 */
export interface RtspAuthConfig {
  /**
   * Username clients must present.
   */
  username: string;

  /**
   * Password clients must present.
   */
  password: string;

  /**
   * Authentication scheme.
   *
   * `Digest` never sends the password over the wire. `Basic` sends it base64
   * encoded and should only be used on trusted networks.
   *
   * @default 'Digest'
   */
  method?: 'Basic' | 'Digest';

  /**
   * Realm announced in the challenge.
   *
   * @default 'seydx-rtsp'
   */
  realm?: string;
}

/**
 * Outcome of checking a request's credentials.
 *
 * `stale` means the credentials are right but the Digest nonce expired, so the
 * client can retry with a fresh nonce without asking the user again.
 */
export type RtspAuthResult = 'ok' | 'stale' | 'denied';

// long enough for a session to reuse its nonce, short enough to limit replays of a captured header
const NONCE_TTL_MS = 5 * 60 * 1000;
const MAX_NONCES = 64;

/**
 * Basic or Digest authentication for {@link RtspServerSink}.
 *
 * Every request must carry valid credentials. Digest nonces expire after five
 * minutes; a client that presents an expired nonce with the right credentials
 * receives a `stale` challenge and retries transparently.
 *
 * @example
 * ```typescript
 * import { RtspAuth, RtspServerSink } from '@seydx/rtsp';
 *
 * const auth = new RtspAuth({ username: 'viewer', password: 'secret' });
 * const server = await new RtspServerSink(relay, { auth }).listen();
 * ```
 *
 * @see {@link RtspServerSink} For the server that uses it
 */
export class RtspAuth {
  private readonly realm: string;
  private readonly nonces = new Map<string, number>();

  /**
   * Create an authenticator.
   *
   * @param config - Credentials, scheme and realm
   *
   * @example
   * ```typescript
   * const auth = new RtspAuth({ username: 'viewer', password: 'secret', method: 'Basic' });
   * ```
   */
  constructor(private readonly config: RtspAuthConfig) {
    this.realm = config.realm ?? 'seydx-rtsp';
  }

  /**
   * The authentication scheme in use.
   *
   * @example
   * ```typescript
   * console.log(auth.method); // 'Digest'
   * ```
   */
  get method(): 'Basic' | 'Digest' {
    return this.config.method ?? 'Digest';
  }

  /**
   * The expected username.
   *
   * @example
   * ```typescript
   * console.log(auth.username);
   * ```
   */
  get username(): string {
    return this.config.username;
  }

  /**
   * Build the `WWW-Authenticate` header for a 401 response.
   *
   * @param stale - Mark the challenge stale after an expired Digest nonce
   *
   * @returns The header value with a fresh nonce for Digest
   *
   * @example
   * ```typescript
   * const header = auth.challenge();
   * ```
   */
  challenge(stale = false): string {
    if (this.method === 'Basic') return `Basic realm="${this.realm}"`;
    return `Digest realm="${this.realm}", nonce="${this.issueNonce()}"${stale ? ', stale=TRUE' : ''}`;
  }

  /**
   * Check the `Authorization` header of a request.
   *
   * @param method - RTSP method of the request, for example `DESCRIBE`
   *
   * @param uri - Request URI, used when the header names none
   *
   * @param header - The `Authorization` header, if present
   *
   * @returns `ok`, `stale` for right credentials with an expired nonce, or `denied`
   *
   * @example
   * ```typescript
   * if (auth.verify('DESCRIBE', uri, headers.authorization) !== 'ok') reject();
   * ```
   */
  verify(method: string, uri: string, header: string | undefined): RtspAuthResult {
    if (!header) return 'denied';
    const space = header.indexOf(' ');
    const scheme = (space === -1 ? header : header.slice(0, space)).toLowerCase();
    const value = space === -1 ? '' : header.slice(space + 1).trim();

    if (this.method === 'Basic') {
      if (scheme !== 'basic') return 'denied';
      const expected = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
      return safeEqual(value, expected) ? 'ok' : 'denied';
    }

    if (scheme !== 'digest') return 'denied';
    const params = parseParams(value);
    if (params.username !== this.config.username || !params.nonce) return 'denied';
    const ha1 = md5(`${this.config.username}:${this.realm}:${this.config.password}`);
    const ha2 = md5(`${method}:${params.uri || uri}`);
    if (!safeEqual(params.response ?? '', md5(`${ha1}:${params.nonce}:${ha2}`))) return 'denied';
    return this.isNonceValid(params.nonce) ? 'ok' : 'stale';
  }

  /**
   * Create and remember a nonce, evicting the oldest beyond the limit.
   *
   * @returns The nonce
   *
   * @internal
   */
  private issueNonce(): string {
    this.pruneNonces();
    const nonce = randomBytes(16).toString('hex');
    this.nonces.set(nonce, Date.now() + NONCE_TTL_MS);
    for (const oldest of this.nonces.keys()) {
      if (this.nonces.size <= MAX_NONCES) break;
      this.nonces.delete(oldest);
    }
    return nonce;
  }

  /**
   * Whether a nonce was issued here and has not expired.
   *
   * @param nonce - The nonce to check
   *
   * @returns `true` if it is still valid
   *
   * @internal
   */
  private isNonceValid(nonce: string): boolean {
    this.pruneNonces();
    return this.nonces.has(nonce);
  }

  /**
   * Drop expired nonces.
   *
   * @internal
   */
  private pruneNonces(): void {
    const now = Date.now();
    for (const [nonce, expires] of this.nonces) {
      if (expires <= now) this.nonces.delete(nonce);
    }
  }
}

/**
 * Hex MD5 digest of a string.
 *
 * @param input - The string to hash
 *
 * @returns The digest
 *
 * @internal
 */
function md5(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

/**
 * Constant-time string comparison.
 *
 * @param a - First string
 *
 * @param b - Second string
 *
 * @returns `true` if both are equal
 *
 * @internal
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Parse the comma-separated `key=value` list of a Digest header.
 *
 * @param input - The header value after the scheme
 *
 * @returns The parameters with lower-case keys
 *
 * @internal
 */
function parseParams(input: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const match of input.matchAll(/(\w+)=(?:"([^"]*)"|([^,]*))/g)) {
    params[match[1].toLowerCase()] = (match[2] ?? match[3] ?? '').trim();
  }
  return params;
}
