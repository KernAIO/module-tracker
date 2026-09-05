import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import { BlockList, isIP } from 'node:net'

/**
 * The outbound half of the workflow "Call webhook" post-function.
 *
 * A workspace admin types this URL, and on Kern Cloud every self-signup is the owner of their own
 * workspace — so without a gate here, any customer can make the host service issue a request, with
 * headers and a body they choose, to any address the service can reach: the other services on the
 * internal network, and the cloud provider's metadata endpoint on 169.254.169.254. That is the whole
 * of server-side request forgery, and `fetch(intent.url)` is all it took.
 *
 * Four things have to hold, and each one closes a hole the other three leave open:
 *
 *  1. **Scheme.** Only http and https. `z.string().url()` in `@kernhq/workflow` accepts anything
 *     `new URL()` parses, `file:` and `gopher:` included.
 *  2. **Address.** Resolve the hostname and refuse loopback, private, link-local, unique-local,
 *     multicast and the reserved ranges. Checking the *hostname* is worthless: `localtest.me` and a
 *     thousand other public names resolve to 127.0.0.1 on purpose.
 *  3. **Pinning.** Resolve first, then connect to the address that was checked. Validating a name and
 *     then handing the name to the transport re-resolves it, and a DNS record with a one-second TTL
 *     answers public for the check and private for the connection. `lookup` on the request is what
 *     makes the socket go to the address we vetted; the hostname is still what signs TLS and what
 *     goes in the `Host` header, so nothing else about the request changes.
 *  4. **Redirects.** A public host answering 302 to `http://169.254.169.254/` walks straight through
 *     the first three, because the redirect is followed by the transport after every check has
 *     passed. Node's `http.request` does not follow redirects at all, and we do not add it: a
 *     webhook receiver returns 2xx, and each hop would be a fresh instance of this same problem.
 *
 * Plus a response cap and a timeout, so a hostile endpoint cannot hold the socket open or stream a
 * gigabyte into a service that never wanted the body.
 */

/** Addresses no workspace may reach through a webhook. */
const blocked = new BlockList()

// IPv4. `net.BlockList` converts an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`) and checks it
// against these, so the v4 rules cover the mapped form too — verified, not assumed.
blocked.addSubnet('0.0.0.0', 8, 'ipv4') // "this network"
blocked.addSubnet('10.0.0.0', 8, 'ipv4') // private
blocked.addSubnet('100.64.0.0', 10, 'ipv4') // carrier-grade NAT
blocked.addSubnet('127.0.0.0', 8, 'ipv4') // loopback
blocked.addSubnet('169.254.0.0', 16, 'ipv4') // link-local — the cloud metadata endpoint
blocked.addSubnet('172.16.0.0', 12, 'ipv4') // private
blocked.addSubnet('192.0.0.0', 24, 'ipv4') // IETF protocol assignments
blocked.addSubnet('192.0.2.0', 24, 'ipv4') // TEST-NET-1
blocked.addSubnet('192.88.99.0', 24, 'ipv4') // 6to4 relay anycast
blocked.addSubnet('192.168.0.0', 16, 'ipv4') // private
blocked.addSubnet('198.18.0.0', 15, 'ipv4') // benchmarking
blocked.addSubnet('198.51.100.0', 24, 'ipv4') // TEST-NET-2
blocked.addSubnet('203.0.113.0', 24, 'ipv4') // TEST-NET-3
blocked.addSubnet('224.0.0.0', 4, 'ipv4') // multicast
blocked.addSubnet('240.0.0.0', 4, 'ipv4') // reserved, and 255.255.255.255 with it

// IPv6.
blocked.addAddress('::', 'ipv6') // unspecified
blocked.addAddress('::1', 'ipv6') // loopback
blocked.addSubnet('64:ff9b::', 96, 'ipv6') // NAT64 translation
blocked.addSubnet('100::', 64, 'ipv6') // discard-only
blocked.addSubnet('2001::', 23, 'ipv6') // IETF protocol assignments, Teredo included
blocked.addSubnet('2001:db8::', 32, 'ipv6') // documentation
blocked.addSubnet('fc00::', 7, 'ipv6') // unique local
blocked.addSubnet('fe80::', 10, 'ipv6') // link-local
blocked.addSubnet('ff00::', 8, 'ipv6') // multicast

/** True when nothing in a workspace may open a connection to this address. */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 0) return true // not an address at all — refuse rather than guess
  return blocked.check(address, version === 4 ? 'ipv4' : 'ipv6')
}

/** Refused before the socket was opened. Carries a reason a self-hoster can act on. */
export class WebhookRefused extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'WebhookRefused'
  }
}

export interface WebhookRequest {
  url: string
  method: 'POST' | 'PUT' | 'GET'
  headers?: Record<string, string>
  /** already serialised; undefined for GET */
  body?: string
}

export interface WebhookOptions {
  /**
   * Overridden only by the tests, which need a server they can actually start — and a server you can
   * start is on loopback, which is precisely what the default refuses. Nothing in the module passes
   * it.
   */
  isBlockedAddress?: (address: string) => boolean
  /** Read and discarded; a webhook's response body is not used for anything. */
  maxResponseBytes?: number
  timeoutMs?: number
}

export interface WebhookResult {
  status: number
  /** true when the endpoint sent more than the cap and the rest was dropped */
  truncated: boolean
}

/** Headers a caller must not set: they describe the connection, not the message. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
])

/**
 * Check the URL and resolve it to one address that may be reached.
 *
 * Every address the name resolves to has to pass, not merely the one we go on to use: a host that
 * answers with a public and a private record is not a host this feature is for, and refusing the set
 * is a sentence an operator can act on, where "we picked the second one" is not.
 */
export async function resolveWebhookTarget(
  raw: string,
  isBlocked: (address: string) => boolean = isBlockedAddress,
): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new WebhookRefused('the webhook URL could not be parsed')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebhookRefused(`only http and https webhooks are allowed, not ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new WebhookRefused('credentials in a webhook URL are not allowed')
  }

  // `URL` keeps an IPv6 literal in its brackets; `net` wants it without.
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname

  const literal = isIP(host)
  if (literal !== 0) {
    if (isBlocked(host)) throw new WebhookRefused(`${host} is not a public address`)
    return { url, address: host, family: literal === 4 ? 4 : 6 }
  }

  let resolved: Array<{ address: string; family: number }>
  try {
    resolved = await dnsLookup(host, { all: true, verbatim: true })
  } catch {
    throw new WebhookRefused(`${host} could not be resolved`)
  }

  for (const entry of resolved) {
    if (isBlocked(entry.address)) {
      throw new WebhookRefused(`${host} resolves to ${entry.address}, which is not a public address`)
    }
  }
  const first = resolved[0]
  if (!first) throw new WebhookRefused(`${host} could not be resolved`)
  return { url, address: first.address, family: first.family === 4 ? 4 : 6 }
}

/**
 * Send the address we vetted, not the name we vetted it from.
 *
 * `net` calls this with `all: true` when it is running happy-eyeballs (the default since Node 20) and
 * without it otherwise, and the two want different shapes back. Answering only one of them makes the
 * connection hang rather than fail, which is the kind of thing that looks like a slow endpoint.
 */
function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{ address, family }])
    else callback(null, address, family)
  }
}

/** Perform one vetted webhook call. Resolves with the status; rejects on refusal or transport error. */
export async function sendWebhook(req: WebhookRequest, options: WebhookOptions = {}): Promise<WebhookResult> {
  const maxResponseBytes = options.maxResponseBytes ?? 64 * 1024
  const timeoutMs = options.timeoutMs ?? 10_000

  const { url, address, family } = await resolveWebhookTarget(req.url, options.isBlockedAddress)

  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue
    headers[name] = value
  }
  if (req.body !== undefined) {
    headers['content-type'] ??= 'application/json'
    headers['content-length'] = String(Buffer.byteLength(req.body))
  }

  const send = url.protocol === 'https:' ? httpsRequest : httpRequest

  return await new Promise<WebhookResult>((resolve, reject) => {
    const request = send(
      url,
      {
        method: req.method,
        headers,
        lookup: pinnedLookup(address, family),
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        const status = response.statusCode ?? 0

        // A redirect is a second request to an address nothing has checked. Refuse it here rather
        // than re-running the whole gate per hop: a webhook receiver answers 2xx.
        if (status >= 300 && status < 400) {
          response.destroy()
          request.destroy()
          reject(new WebhookRefused(`the endpoint answered ${status}; webhook redirects are not followed`))
          return
        }

        let seen = 0
        let truncated = false
        response.on('data', (chunk: Buffer) => {
          seen += chunk.length
          if (seen > maxResponseBytes && !truncated) {
            truncated = true
            response.destroy()
            request.destroy()
            resolve({ status, truncated: true })
          }
        })
        response.on('end', () => {
          if (!truncated) resolve({ status, truncated: false })
        })
        response.on('error', (err) => {
          if (!truncated) reject(err)
        })
      },
    )

    request.on('error', reject)
    if (req.body !== undefined) request.write(req.body)
    request.end()
  })
}
