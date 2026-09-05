import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { isBlockedAddress, resolveWebhookTarget, sendWebhook, WebhookRefused } from './webhook.js'

/**
 * The workflow "Call webhook" post-function is a URL a workspace admin types, and on Kern Cloud
 * every self-signup owns their own workspace — so this file is the proof that a customer cannot
 * point it at the internal network or at 169.254.169.254.
 *
 * The transport tests override the address policy, because a server this suite can actually start
 * is on loopback and loopback is exactly what the policy refuses. Nothing in the module passes that
 * override; the policy tests below run against the real one.
 */

const allowLoopback = { isBlockedAddress: () => false }

describe('address policy', () => {
  it('refuses loopback, private, link-local and unique-local addresses', () => {
    for (const address of [
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // the cloud metadata endpoint
      '100.64.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1', // the same loopback, written as IPv4-mapped IPv6
      '::ffff:169.254.169.254',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true)
    }
  })

  it('allows ordinary public addresses', () => {
    for (const address of ['93.184.216.34', '1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
      expect(isBlockedAddress(address), address).toBe(false)
    }
  })

  it('refuses anything that is not an address at all', () => {
    expect(isBlockedAddress('not-an-address')).toBe(true)
  })
})

describe('resolveWebhookTarget', () => {
  it('refuses a scheme that is not http or https', async () => {
    // `z.string().url()` in @kernhq/workflow accepts every one of these.
    for (const url of ['file:///etc/passwd', 'gopher://example.com/', 'ftp://example.com/']) {
      await expect(resolveWebhookTarget(url)).rejects.toThrow(WebhookRefused)
    }
  })

  it('refuses credentials in the URL', async () => {
    await expect(resolveWebhookTarget('http://user:pass@example.com/')).rejects.toThrow(/credentials/)
  })

  it('refuses a private address written directly', async () => {
    await expect(resolveWebhookTarget('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /not a public address/,
    )
    await expect(resolveWebhookTarget('http://10.0.0.5:4000/api/core/health')).rejects.toThrow(
      /not a public address/,
    )
    await expect(resolveWebhookTarget('http://[::1]:4000/')).rejects.toThrow(/not a public address/)
  })

  it('refuses a public name that resolves to a private address', async () => {
    // `localhost` is a real name going through the real resolver, and it lands on 127.0.0.1 — the
    // shape of every "public hostname, private answer" trick, and the reason a hostname allowlist
    // would be worthless here.
    await expect(resolveWebhookTarget('http://localhost:9/hook')).rejects.toThrow(
      /resolves to .*not a public address/,
    )
  })

  it('resolves a name to an address it then pins', async () => {
    // No network: the policy is injected, so this exercises the resolve-and-return path only.
    const target = await resolveWebhookTarget('https://localhost/hook', () => false)
    expect(target.url.protocol).toBe('https:')
    expect(['127.0.0.1', '::1']).toContain(target.address)
    expect([4, 6]).toContain(target.family)
  })
})

describe('sendWebhook', () => {
  let server: Server | undefined
  const seen: Array<{ url: string; method: string; headers: IncomingMessage['headers']; body: string }> = []

  afterEach(async () => {
    if (server) await new Promise<void>((done) => server?.close(() => done()))
    server = undefined
    seen.length = 0
  })

  async function start(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        seen.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, body })
        handler(req, res)
      })
    })
    await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done))
    const { port } = server.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  it('delivers a legitimate call with its body and headers', async () => {
    const base = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })

    const result = await sendWebhook(
      {
        url: `${base}/hook`,
        method: 'POST',
        headers: { 'x-kern-token': 'shh' },
        body: JSON.stringify({ issue: { key: 'KERN-1' } }),
      },
      allowLoopback,
    )

    expect(result).toEqual({ status: 200, truncated: false })
    expect(seen).toHaveLength(1)
    expect(seen[0].method).toBe('POST')
    expect(seen[0].url).toBe('/hook')
    expect(seen[0].headers['x-kern-token']).toBe('shh')
    expect(seen[0].headers['content-type']).toBe('application/json')
    expect(JSON.parse(seen[0].body)).toEqual({ issue: { key: 'KERN-1' } })
  })

  it('sends a GET without a body', async () => {
    const base = await start((_req, res) => {
      res.writeHead(204)
      res.end()
    })
    const result = await sendWebhook({ url: `${base}/ping`, method: 'GET' }, allowLoopback)
    expect(result.status).toBe(204)
    expect(seen[0].method).toBe('GET')
    expect(seen[0].body).toBe('')
  })

  it('refuses to follow a redirect, whatever it points at', async () => {
    // The shape the first three checks cannot see: every one of them passes, and then the
    // transport takes a second trip to an address nothing vetted.
    const base = await start((req, res) => {
      if (req.url === '/hook') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
        res.end()
        return
      }
      res.writeHead(200)
      res.end('followed')
    })

    await expect(sendWebhook({ url: `${base}/hook`, method: 'GET' }, allowLoopback)).rejects.toThrow(
      /redirects are not followed/,
    )
    // One request reached the server and no second one was attempted.
    expect(seen.map((s) => s.url)).toEqual(['/hook'])
  })

  it('stops reading once the response passes the cap', async () => {
    const base = await start((_req, res) => {
      res.writeHead(200)
      res.end('x'.repeat(200_000))
    })
    const result = await sendWebhook(
      { url: `${base}/big`, method: 'GET' },
      { ...allowLoopback, maxResponseBytes: 1024 },
    )
    expect(result).toEqual({ status: 200, truncated: true })
  })

  it('gives up on an endpoint that never answers', async () => {
    const base = await start(() => {
      /* hold the socket open and answer nothing */
    })
    await expect(
      sendWebhook({ url: `${base}/slow`, method: 'GET' }, { ...allowLoopback, timeoutMs: 250 }),
    ).rejects.toThrow()
  })

  it('drops headers that describe the connection rather than the message', async () => {
    const base = await start((_req, res) => {
      res.writeHead(200)
      res.end()
    })
    await sendWebhook(
      {
        url: `${base}/hook`,
        method: 'POST',
        headers: { host: 'metadata.google.internal', 'content-length': '99999' },
        body: '{}',
      },
      allowLoopback,
    )
    expect(seen[0].headers.host).toBe(new URL(base).host)
    expect(seen[0].headers['content-length']).toBe('2')
  })

  it('refuses a private target before opening any socket', async () => {
    // The real policy, not the override.
    await expect(
      sendWebhook({ url: 'http://169.254.169.254/latest/meta-data/', method: 'GET' }),
    ).rejects.toThrow(WebhookRefused)
  })
})
