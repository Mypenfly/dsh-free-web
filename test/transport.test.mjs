/**
 * Offline tests for the transport and the proxy selection. No network.
 *
 * A local `http.createServer` stands in for the web and for a proxy, so every
 * branch here (direct, absolute-form, CONNECT, redirects, decoding, caps,
 * cancellation) runs without a DNS or TLS dependency. The TLS-over-tunnel branch
 * is covered live by `scripts/smoke.mjs`, which reaches the public web through the
 * environment's proxy.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import { once } from 'node:events'

import {
  describeProxy,
  ipv4InCidr,
  matchesNoProxy,
  parseNoProxyEntry,
  parseProxyUrl,
  proxyFor,
  readProxyEnv,
} from '../src/util/proxy.mjs'
import {
  ResponseHeaders,
  decodeWithCharset,
  readCappedText,
  request,
} from '../src/util/transport.mjs'
import { getText } from '../src/util/http.mjs'

/**
 * Run a body against a throwaway local HTTP server.
 *
 * @param {(request: http.IncomingMessage, response: http.ServerResponse) => void} handler request handler
 * @param {(target: { origin: string, port: number }) => Promise<void>} run test body
 * @returns {Promise<void>} resolves when the test body and cleanup finished
 */
async function withServer(handler, run) {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  try {
    await run({ origin: `http://127.0.0.1:${port}`, port })
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

test('proxy: scheme-specific variable wins, all_proxy is the fallback', () => {
  const env = {
    http_proxy: 'http://127.0.0.1:7897',
    https_proxy: 'http://127.0.0.1:7897',
    all_proxy: 'http://127.0.0.1:9999',
    no_proxy: 'localhost,127.0.0.1',
  }
  assert.deepEqual(proxyFor('https://example.com/a', env), { scheme: 'http', hostname: '127.0.0.1', port: 7897 })
  assert.deepEqual(proxyFor('http://example.com/a', env), { scheme: 'http', hostname: '127.0.0.1', port: 7897 })
  assert.deepEqual(proxyFor('https://example.com/a', { all_proxy: '127.0.0.1:3128' }), {
    scheme: 'http',
    hostname: '127.0.0.1',
    port: 3128,
  })
  assert.equal(proxyFor('http://example.com/', {}), undefined, 'no proxy variables means direct')
})

test('proxy: no_proxy covers exact hosts, suffixes, ports, IPv6 and IPv4 CIDR', () => {
  const env = {
    https_proxy: 'http://127.0.0.1:7897',
    no_proxy: 'localhost,exact.example,.suffix.example,ported.example:8443,192.168.0.0/16,10.0.0.0/8,[::1]',
  }
  assert.equal(proxyFor('https://localhost:3000/', env), undefined)
  assert.equal(proxyFor('https://exact.example/', env), undefined)
  assert.equal(proxyFor('https://deep.sub.suffix.example/', env), undefined)
  assert.equal(proxyFor('https://ported.example:8443/', env), undefined)
  assert.notEqual(proxyFor('https://ported.example:9443/', env), undefined, 'the port must match too')
  assert.equal(proxyFor('https://192.168.4.5/', env), undefined)
  assert.equal(proxyFor('https://10.1.2.3/', env), undefined)
  assert.notEqual(proxyFor('https://172.16.0.1/', env), undefined, '172.16/12 is not in this list')
  assert.equal(proxyFor('https://[::1]:9000/', env), undefined)
  assert.notEqual(proxyFor('https://example.com/', env), undefined)
  assert.equal(matchesNoProxy('anything.example', 443, '*'), true)
})

test('proxy: host suffix matching does not leak across label boundaries', () => {
  assert.equal(matchesNoProxy('evil-example.com', 443, 'example.com'), false)
  assert.equal(matchesNoProxy('sub.example.com', 443, '.example.com'), true)
  assert.equal(matchesNoProxy('example.com', 443, 'example.com'), true)
})

test('proxy: an unsupported scheme is a direct connection, not a silent lie', () => {
  assert.equal(parseProxyUrl('socks5://127.0.0.1:1080'), undefined)
  assert.equal(parseProxyUrl('ftp://127.0.0.1:21'), undefined)
  assert.equal(proxyFor('https://example.com/', { https_proxy: 'socks5h://127.0.0.1:1080' }), undefined)
})

test('proxy: credentials become a Basic proxy-authorization value', () => {
  const proxy = parseProxyUrl('http://user:p%40ss@127.0.0.1:7897')
  assert.equal(proxy.authorization, `Basic ${Buffer.from('user:p@ss').toString('base64')}`)
  assert.equal(describeProxy(proxy), 'http://127.0.0.1:7897')
  assert.equal(readProxyEnv({ HTTPS_PROXY: 'http://127.0.0.1:1' }).https, 'http://127.0.0.1:1', 'uppercase is read')
  assert.equal(readProxyEnv({ https_proxy: 'http://127.0.0.1:2', HTTPS_PROXY: 'http://127.0.0.1:3' }).https, 'http://127.0.0.1:2')
  assert.deepEqual(parseNoProxyEntry('a.example:8080'), { host: 'a.example', port: 8080 })
  assert.equal(ipv4InCidr('192.168.7.9', { address: '192.168.0.0', bits: 16 }), true)
  assert.equal(ipv4InCidr('192.169.7.9', { address: '192.168.0.0', bits: 16 }), false)
})

test('transport: a direct GET returns status, headers and a decodable body', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-hop': 'one' })
      res.end('hello from the socket')
    },
    async ({ origin }) => {
      const response = await request(`${origin}/text`, { proxy: null, headers: { 'x-test': '1' } })
      assert.equal(response.status, 200)
      assert.equal(response.ok, true)
      assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
      assert.equal(response.headers.get('X-Hop'), 'one', 'header lookup is case-insensitive')
      const { text, truncated } = await readCappedText(response, 1024)
      assert.equal(text, 'hello from the socket')
      assert.equal(truncated, false)
    },
  )
})

test('transport: gzip, brotli and raw deflate bodies are decoded', async () => {
  const payload = 'compressed payload — 中文 ✓ '.repeat(40)
  const cases = [
    ['gzip', zlib.gzipSync(payload)],
    ['br', zlib.brotliCompressSync(payload)],
    ['deflate', zlib.deflateSync(payload)],
    ['deflate-raw', zlib.deflateRawSync(payload)],
  ]
  for (const [name, encoded] of cases) {
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-encoding': name.replace('-raw', '') })
        res.end(encoded)
      },
      async ({ origin }) => {
        const response = await request(`${origin}/${name}`, { proxy: null })
        const { text, truncated } = await readCappedText(response, 1024 * 1024)
        assert.equal(text, payload, `${name} must round-trip`)
        assert.equal(truncated, false)
      },
    )
  }
})

test('transport: the byte cap truncates instead of buffering the whole body', async () => {
  const body = 'x'.repeat(100_000)
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(body)
    },
    async ({ origin }) => {
      const response = await request(`${origin}/big`, { proxy: null })
      const { text, truncated, bytes } = await readCappedText(response, 1000)
      assert.equal(truncated, true)
      assert.equal(text.length, 1000)
      assert.ok(bytes > 1000, `expected to have seen more than the cap, saw ${bytes}`)
    },
  )
})

test('transport: a compressed body cannot expand past the cap', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
      res.end(zlib.gzipSync('y'.repeat(200_000)))
    },
    async ({ origin }) => {
      const response = await request(`${origin}/bomb`, { proxy: null })
      const { text, truncated } = await readCappedText(response, 4096)
      assert.equal(truncated, true)
      assert.equal(text.length, 4096)
    },
  )
})

test('transport: one hop only — a redirect is reported, not followed', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/next' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('end')
    },
    async ({ origin }) => {
      const response = await request(`${origin}/start`, { proxy: null })
      assert.equal(response.status, 302)
      assert.equal(response.headers.get('location'), '/next')
      response.stream.destroy()
    },
  )
})

test('getText: follows a relative redirect chain and reports the final URL', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/a') {
        res.writeHead(301, { location: '/b' })
        res.end()
        return
      }
      if (req.url === '/b') {
        res.writeHead(307, { location: '/c' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('final body')
    },
    async ({ origin }) => {
      const page = await getText(`${origin}/a`, { proxy: null, timeoutMs: 4000 })
      assert.equal(page.status, 200)
      assert.equal(page.text, 'final body')
      assert.equal(page.url, `${origin}/c`)
      await assert.rejects(
        getText(`${origin}/a`, { proxy: null, timeoutMs: 4000, maxRedirects: 0 }),
        (error) => error.code === 'WEB_PROVIDER_ERROR' && /redirects/.test(error.message),
      )
    },
  )
})

test('getText: a body that never arrives is cancelled, and a deadline is a timeout', async () => {
  await withServer(
    (req) => {
      // Never respond; the client must not wait forever.
    },
    async ({ origin }) => {
      const controller = new AbortController()
      const aborted = getText(`${origin}/hang`, { proxy: null, timeoutMs: 5000, signal: controller.signal })
      setTimeout(() => controller.abort(new Error('user went away')), 30)
      await assert.rejects(aborted, (error) => error.code === 'WEB_ABORTED')

      await assert.rejects(
        getText(`${origin}/hang`, { proxy: null, timeoutMs: 60 }),
        (error) => error.code === 'WEB_PROVIDER_ERROR' && /timed out/.test(error.message),
      )
    },
  )
})

test('transport: a refused connection surfaces the socket error code', async () => {
  await assert.rejects(
    getText('http://127.0.0.1:1/', { proxy: null, timeoutMs: 3000 }),
    (error) => error.code === 'WEB_PROVIDER_ERROR' && /ECONNREFUSED/.test(error.message),
  )
})

test('transport: publicOnly refuses loopback by literal and by name', async () => {
  await withServer(
    (req, res) => {
      res.end('should not be reachable')
    },
    async ({ origin, port }) => {
      await assert.rejects(
        request(`${origin}/private`, { proxy: null, publicOnly: true }),
        (error) => error.code === 'WEB_BLOCKED_URL',
      )
      await assert.rejects(
        request(`http://localhost:${port}/private`, { proxy: null, publicOnly: true }),
        (error) => error.code === 'WEB_BLOCKED_URL',
      )
      // The same host is fine when the caller is not protecting a fetch.
      const response = await request(`${origin}/private`, { proxy: null })
      assert.equal(response.status, 200)
      await readCappedText(response, 1024)
    },
  )
})

test('transport: a hostname is resolved once and the verified answer is pinned', async () => {
  await withServer(
    (req, res) => {
      res.end('pinned')
    },
    async ({ port }) => {
      // `localhost` resolves through DNS (not an IP literal), so this reaches the
      // pinned-lookup path; `proxy: null` keeps the ambient proxy out of it.
      const response = await request(`http://localhost:${port}/pin`, { proxy: null, timeoutMs: 3000 })
      const { text } = await readCappedText(response, 1024)
      assert.equal(text, 'pinned')
    },
  )
})

test('transport: an http target behind a proxy uses an absolute-form request line', async () => {
  const seen = []
  await withServer(
    (req, res) => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, auth: req.headers['proxy-authorization'] })
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('proxied body')
    },
    async ({ port }) => {
      const proxy = { scheme: 'http', hostname: '127.0.0.1', port, authorization: 'Basic dXNlcjpwYXNz' }
      const response = await request('http://example.test/hello?x=1', { proxy, timeoutMs: 3000 })
      assert.equal(response.status, 200)
      const { text } = await readCappedText(response, 1024)
      assert.equal(text, 'proxied body')
      assert.deepEqual(seen[0], {
        method: 'GET',
        url: 'http://example.test/hello?x=1',
        host: 'example.test',
        auth: 'Basic dXNlcjpwYXNz',
      })
    },
  )
})

test('transport: an https target behind a proxy opens a CONNECT tunnel', async () => {
  const seen = []
  const proxy = http.createServer((req, res) => {
    res.writeHead(405)
    res.end()
  })
  proxy.on('connect', (req, socket) => {
    seen.push({ method: req.method, authority: req.url, host: req.headers.host, auth: req.headers['proxy-authorization'] })
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const { port } = proxy.address()
  try {
    await assert.rejects(
      request('https://example.test/page', {
        proxy: { scheme: 'http', hostname: '127.0.0.1', port, authorization: 'Basic abc' },
        timeoutMs: 3000,
      }),
      (error) => /refused CONNECT example\.test:443/.test(error.message) && /HTTP 407/.test(error.message),
    )
    assert.deepEqual(seen[0], {
      method: 'CONNECT',
      authority: 'example.test:443',
      host: 'example.test:443',
      auth: 'Basic abc',
    })
  } finally {
    proxy.closeAllConnections?.()
    await new Promise((resolve) => proxy.close(resolve))
  }
})

test('headers: repeated values join, set-cookie stays a list', () => {
  const headers = new ResponseHeaders([
    'content-type', 'text/html',
    'vary', 'accept',
    'vary', 'accept-encoding',
    'set-cookie', 'a=1',
    'set-cookie', 'b=2',
  ])
  assert.equal(headers.get('vary'), 'accept, accept-encoding')
  assert.deepEqual(headers.getSetCookie(), ['a=1', 'b=2'])
  assert.equal(headers.get('missing'), null)
  assert.equal(headers.has('content-type'), true)
})

test('charset: a declared non-UTF-8 charset is honoured', () => {
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) // 中文 in GBK
  assert.equal(decodeWithCharset(gbk, 'text/html; charset=gbk'), '中文')
  assert.equal(decodeWithCharset(Buffer.from('中文'), 'text/html; charset=utf-8'), '中文')
  assert.equal(decodeWithCharset(Buffer.from('中文'), null), '中文')
})
