import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Credentials and scheme configuration for RTSP server authentication.
 *
 * Describes the single account that an {@link RtspServerSink} will require
 * clients to authenticate against, along with the authentication scheme to
 * advertise and the protection realm presented in the challenge.
 */
export interface RtspAuthConfig {
  /**
   * The account name a client must present.
   *
   * Compared verbatim against the username supplied by the client (the Basic
   * credential pair or the Digest `username` parameter).
   */
  username: string;

  /**
   * The secret associated with {@link RtspAuthConfig.username}.
   *
   * Used to build the expected Basic credential or the Digest HA1 hash. Stored
   * as provided; it is never sent to the client.
   */
  password: string;

  /**
   * The authentication scheme to advertise and enforce.
   *
   * `Digest` performs a challenge-response exchange and never transmits the
   * password over the wire, while `Basic` sends base64-encoded credentials and
   * should only be used over a secured transport. Defaults to `Digest`.
   */
  method?: 'Basic' | 'Digest';

  /**
   * The protection realm presented in the authentication challenge.
   *
   * Surfaced to clients in the `WWW-Authenticate` header and, for Digest, mixed
   * into the HA1 hash. Defaults to `seydx-rtsp`.
   */
  realm?: string;
}

/**
 * Compute the hex-encoded MD5 digest of a string.
 *
 * @param input - The string to hash
 *
 * @returns The lowercase hexadecimal MD5 digest
 *
 * @internal
 */
function md5(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

/**
 * Compare two strings in length- and content-constant time.
 *
 * Uses a timing-safe comparison so that credential checks do not leak
 * information about how many leading characters matched.
 *
 * @param a - The first string to compare
 *
 * @param b - The second string to compare
 *
 * @returns `true` if the strings are byte-for-byte equal
 *
 * @internal
 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Parse a `key=value, key="value"` parameter list from a Digest auth header.
 *
 * Keys are lowercased and quoted values are unquoted; both quoted and bare
 * value forms are accepted and trimmed.
 *
 * @param input - The parameter portion of the Authorization header
 *
 * @returns A map of lowercased parameter names to their values
 *
 * @internal
 */
function parseParams(input: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    params[m[1].toLowerCase()] = (m[2] ?? m[3] ?? '').trim();
  }
  return params;
}

/**
 * Server-side RTSP authenticator for a single set of credentials.
 *
 * Validates incoming client requests against one configured account using
 * either Basic or Digest authentication. It produces the challenge string the
 * server returns when credentials are missing or invalid, and verifies the
 * Authorization header that clients send in response. For Digest, a fresh nonce
 * is generated per instance and all comparisons run in constant time.
 *
 * @example
 * ```typescript
 * import { RtspAuth } from '@seydx/rtsp';
 *
 * const auth = new RtspAuth({ username: 'admin', password: 'secret' });
 *
 * // On a missing or rejected request, return the challenge to the client:
 * const wwwAuthenticate = auth.challenge();
 *
 * // When a client retries with an Authorization header, verify it:
 * const ok = auth.verify('DESCRIBE', 'rtsp://host/stream', authorizationHeader);
 * ```
 *
 * @see {@link RtspServerSink} For the sink that enforces authentication
 */
export class RtspAuth {
  private readonly realm: string;
  private readonly nonce = randomBytes(16).toString('hex');

  /**
   * Create an authenticator for a single account.
   *
   * @param config - Credentials, scheme, and realm to enforce
   *
   * @example
   * ```typescript
   * const auth = new RtspAuth({ username: 'admin', password: 'secret', method: 'Digest' });
   * ```
   */
  constructor(private readonly config: RtspAuthConfig) {
    this.realm = config.realm ?? 'seydx-rtsp';
  }

  /**
   * The authentication scheme this instance enforces.
   *
   * Resolves the configured method, defaulting to `Digest` when unset.
   *
   * @example
   * ```typescript
   * if (auth.method === 'Basic') {
   *   // credentials will be sent base64-encoded
   * }
   * ```
   */
  get method(): 'Basic' | 'Digest' {
    return this.config.method ?? 'Digest';
  }

  /**
   * The account name clients must present.
   *
   * @example
   * ```typescript
   * console.log(`expecting login for ${auth.username}`);
   * ```
   */
  get username(): string {
    return this.config.username;
  }

  /**
   * Build the value for the `WWW-Authenticate` response header.
   *
   * Returns the challenge appropriate to the configured scheme: a realm-only
   * challenge for Basic, or a realm plus the per-instance nonce for Digest.
   * Send this when a request arrives without credentials or fails verification.
   *
   * @returns The header value to return to the client
   *
   * @example
   * ```typescript
   * response.setHeader('WWW-Authenticate', auth.challenge());
   * ```
   */
  challenge(): string {
    if (this.method === 'Basic') {
      return `Basic realm="${this.realm}"`;
    }
    return `Digest realm="${this.realm}", nonce="${this.nonce}"`;
  }

  /**
   * Validate the `Authorization` header for a given RTSP request.
   *
   * For Basic, compares the supplied base64 credentials against the configured
   * pair. For Digest, recomputes the expected response from the realm, nonce,
   * method, and URI and matches it against the client's value. All comparisons
   * are constant-time, and a missing or malformed header is rejected.
   *
   * @param rtspMethod - The RTSP method of the request (e.g. `DESCRIBE`, `SETUP`)
   *
   * @param uri - The request URI, used as the Digest fallback when the header omits one
   *
   * @param header - The raw `Authorization` header value, if present
   *
   * @returns `true` if the credentials are valid for this request
   *
   * @example
   * ```typescript
   * if (!auth.verify(method, uri, request.headers['authorization'])) {
   *   response.statusCode = 401;
   *   response.setHeader('WWW-Authenticate', auth.challenge());
   * }
   * ```
   */
  verify(rtspMethod: string, uri: string, header: string | undefined): boolean {
    if (!header) return false;
    const [scheme, ...rest] = header.split(' ');
    const value = rest.join(' ');

    if (this.method === 'Basic') {
      if (scheme.toLowerCase() !== 'basic') return false;
      const expected = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
      return safeEqual(value, expected);
    }

    if (scheme.toLowerCase() !== 'digest') return false;
    const p = parseParams(value);
    if (p.username !== this.config.username || p.nonce !== this.nonce) return false;

    const ha1 = md5(`${this.config.username}:${this.realm}:${this.config.password}`);
    const ha2 = md5(`${rtspMethod}:${p.uri || uri}`);
    const expected = md5(`${ha1}:${this.nonce}:${ha2}`);
    return safeEqual(p.response ?? '', expected);
  }
}
