import http from 'node:http';
import https from 'node:https';
import type { KvmCredentials } from '@shared/types';
import { AppError } from '@shared/i18n';

/**
 * Logging in to the AMI MegaRAC web interface and obtaining the KVM session
 * parameters.
 *
 * The BMC web server is GoAhead-Webs, and it is fussy:
 *  - it does not understand chunked requests, so every POST must carry a
 *    Content-Length;
 *  - for jviewer.jnlp it reports a Content-Length larger than the actual body,
 *    so the connection breaks before that many bytes arrive — the response has
 *    to be collected in pieces and treated as complete on 'aborted'.
 */

export interface BmcSession {
  host: string;
  port: number;
  secure: boolean;
  /** Value of the SessionCookie cookie. */
  cookie: string;
  /** See TlsOptions.insecureTls. */
  insecureTls: boolean;
}

export interface TlsOptions {
  port?: number;
  secure?: boolean;
  /**
   * Accept the BMC's self-signed certificate.
   *
   * Defaults to true: a BMC almost always carries a self-signed certificate
   * issued for its factory hostname, and with verification enabled the
   * connection is impossible. The original JViewer does the same (a trust-all
   * X509TrustManager in its Client.java). Set it to false once the BMC
   * certificate has been replaced with one from your own CA — then the
   * connection is protected against MITM.
   */
  insecureTls?: boolean;
}

interface RawResponse {
  status: number;
  body: string;
}

function request(
  opts: {
    host: string;
    port: number;
    secure: boolean;
    path: string;
    method: 'GET' | 'POST';
    insecureTls: boolean;
    cookie?: string;
    body?: string;
  },
  timeoutMs = 15_000,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers['Cookie'] = `SessionCookie=${opts.cookie}`;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = String(Buffer.byteLength(opts.body));
    }

    const transport = opts.secure ? https : http;
    const req = transport.request(
      {
        host: opts.host,
        port: opts.port,
        path: opts.path,
        method: opts.method,
        headers,
        rejectUnauthorized: !opts.insecureTls,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        const finish = () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        res.on('end', finish);
        // The server lied about Content-Length — take whatever arrived.
        res.on('aborted', finish);
      },
    );

    req.setTimeout(timeoutMs, () => req.destroy(new AppError('error.requestTimeout')));
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/**
 * Logs in to the web interface. Returns a session carrying the cookie that
 * both the JNLP request and the KVM session itself need afterwards.
 */
export async function login(
  host: string,
  username: string,
  password: string,
  opts: TlsOptions = {},
): Promise<BmcSession> {
  const port = opts.port ?? (opts.secure ? 443 : 80);
  const secure = opts.secure ?? false;
  const insecureTls = opts.insecureTls ?? true;
  const body =
    `WEBVAR_USERNAME=${encodeURIComponent(username)}` +
    `&WEBVAR_PASSWORD=${encodeURIComponent(password)}`;

  const res = await request({
    host,
    port,
    secure,
    insecureTls,
    path: '/rpc/WEBSES/create.asp',
    method: 'POST',
    body,
  });

  const cookie = /'SESSION_COOKIE'\s*:\s*'([^']+)'/.exec(res.body)?.[1];
  if (!cookie) {
    if (/Access Denied/i.test(res.body)) throw new AppError('error.badCredentials');
    throw new AppError('error.noSessionCookie', { status: res.status });
  }
  // The BMC issues this cookie on a failed login too, but filled with zeroes.
  if (/^0+$/.test(cookie)) throw new AppError('error.badCredentials');

  return { host, port, secure, cookie, insecureTls };
}

/** Parses JNLP arguments: <argument>-key</argument><argument>value</argument>. */
function parseJnlpArgs(jnlp: string): Map<string, string> {
  const values = [...jnlp.matchAll(/<argument>([^<]*)<\/argument>/g)].map((m) => m[1].trim());
  const args = new Map<string, string>();
  for (let i = 0; i < values.length - 1; i++) {
    const key = values[i];
    if (key.startsWith('-')) args.set(key.slice(1), values[i + 1]);
  }
  return args;
}

/**
 * Requests the JNLP and pulls the KVM session parameters out of it.
 *
 * The JNLPSTR=JViewer parameter is mandatory: without it the BMC returns an
 * "empty" JNLP that has neither a kvmtoken nor any ports.
 */
export async function fetchKvmCredentials(session: BmcSession): Promise<KvmCredentials> {
  const path = `/Java/jviewer.jnlp?EXTRNIP=${encodeURIComponent(session.host)}&JNLPSTR=JViewer`;
  const res = await request({
    host: session.host,
    port: session.port,
    secure: session.secure,
    insecureTls: session.insecureTls,
    path,
    method: 'GET',
    cookie: session.cookie,
  });

  const args = parseJnlpArgs(res.body);
  const kvmToken = args.get('kvmtoken');
  if (!kvmToken) throw new AppError('error.noKvmToken');

  const num = (key: string, fallback: number) => {
    const raw = args.get(key);
    const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    host: session.host,
    webCookie: session.cookie,
    kvmToken,
    kvmPort: num('kvmport', 7578),
    kvmSecure: num('kvmsecure', 0) === 1,
    cdPort: num('cdport', 5120),
    fdPort: num('fdport', 5122),
    hdPort: num('hdport', 5123),
    userPrivileges: num('userpriv', 0),
  };
}

/** Ends the web session. Errors are ignored — this is best effort on exit. */
export async function logout(session: BmcSession): Promise<void> {
  try {
    await request({
      host: session.host,
      port: session.port,
      secure: session.secure,
      insecureTls: session.insecureTls,
      path: '/rpc/WEBSES/logout.asp',
      method: 'GET',
      cookie: session.cookie,
    });
  } catch {
    // The session will expire by timeout anyway.
  }
}

/** Login and KVM parameter retrieval in one step. */
export async function connect(
  host: string,
  username: string,
  password: string,
  opts: TlsOptions = {},
): Promise<{ session: BmcSession; credentials: KvmCredentials }> {
  const session = await login(host, username, password, opts);
  const credentials = await fetchKvmCredentials(session);
  return { session, credentials };
}
