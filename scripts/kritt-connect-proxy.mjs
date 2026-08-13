#!/usr/bin/env node

import { timingSafeEqual } from 'node:crypto';
import { Resolver } from 'node:dns';
import http from 'node:http';
import { isIP, connect as netConnect } from 'node:net';
import { pathToFileURL } from 'node:url';

const MAX_AUTHORITY_LENGTH = 512;
const MAX_CONNECTIONS = 128;
const CONNECT_TIMEOUT_MS = 30_000;
const DNS_TIMEOUT_MS = 10_000;

class ConnectProxyError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function ipv4Bytes(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^(0|[1-9]\d{0,2})$/.test(part) ? Number(part) : -1));
  return bytes.every((part) => part >= 0 && part <= 255) ? bytes : null;
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = ipv4Bytes(address) || [];
    if (a === undefined) return false;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  // IPv6 transition mechanisms can encode a private IPv4 destination in an
  // otherwise global-looking address. This narrowly-scoped relay does not need
  // IPv6, so reject it rather than maintain a fragile special-range allowlist.
  return false;
}

export function parseConnectTarget(authority) {
  if (!authority || authority.length > MAX_AUTHORITY_LENGTH || /[\s/@\\?#]/.test(authority)) {
    throw new ConnectProxyError(400, 'Invalid CONNECT target.');
  }
  let parsed;
  try {
    parsed = new URL(`http://${authority}`);
  } catch {
    throw new ConnectProxyError(400, 'Invalid CONNECT target.');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    !hostname ||
    hostname.length > 253 ||
    parsed.port !== '443' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ConnectProxyError(403, 'Only HTTPS CONNECT targets are allowed.');
  }
  return { hostname, port: 443 };
}

function lookupAll(hostname, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const resolver = new Resolver();
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      resolver.cancel();
      finish(reject, new ConnectProxyError(502, 'DNS lookup was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    resolver.resolve4(hostname, (error, addresses) => {
      if (error) finish(reject, error);
      else
        finish(
          resolve,
          addresses.map((address) => ({ address, family: 4 }))
        );
    });
  });
}

async function resolvePublicTarget(hostname, lookup, timeoutMs, controller) {
  const literalFamily = isIP(hostname);
  let addresses;
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    let timeout;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new ConnectProxyError(502, 'DNS lookup timed out or was cancelled.'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
      timeout = setTimeout(() => controller.abort(), timeoutMs);
    });
    try {
      addresses = await Promise.race([
        Promise.resolve().then(() => lookup(hostname, { signal: controller.signal })),
        aborted,
      ]);
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }
  const publicAddresses = addresses
    .filter(({ address }) => isPublicAddress(address))
    .sort((left, right) => Number(right.family === 4) - Number(left.family === 4));
  if (!publicAddresses.length) throw new ConnectProxyError(403, 'CONNECT target is not public.');
  return publicAddresses[0];
}

function proxyAuthorized(header, token) {
  const expected = Buffer.from(`Basic ${Buffer.from(`open-kritt:${token}`).toString('base64')}`);
  const actual = Buffer.from(String(header || ''));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function endSocket(socket, statusCode, reason, headers = []) {
  if (!socket.writable || socket.destroyed) return;
  socket.end(
    [`HTTP/1.1 ${statusCode} ${reason}`, ...headers, 'Connection: close', 'Content-Length: 0', '', ''].join('\r\n')
  );
}

export function createConnectProxy({
  token,
  lookup = lookupAll,
  connect = netConnect,
  maxConnections = MAX_CONNECTIONS,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  dnsTimeoutMs = DNS_TIMEOUT_MS,
} = {}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('A strong proxy token is required.');
  if (!Number.isInteger(maxConnections) || maxConnections < 1) {
    throw new Error('A positive connection limit is required.');
  }
  if (
    !Number.isInteger(connectTimeoutMs) ||
    connectTimeoutMs < 1 ||
    !Number.isInteger(dnsTimeoutMs) ||
    dnsTimeoutMs < 1
  ) {
    throw new Error('Positive connection and DNS timeouts are required.');
  }
  const sockets = new Set();
  let activeConnections = 0;

  const server = http.createServer({ maxHeaderSize: 8 * 1024 }, (_request, response) => {
    response.writeHead(405, { Connection: 'close', 'Content-Length': '0' });
    response.end();
  });
  server.maxConnections = maxConnections;
  server.maxHeadersCount = 32;
  server.headersTimeout = CONNECT_TIMEOUT_MS;
  server.requestTimeout = CONNECT_TIMEOUT_MS;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => endSocket(socket, 400, 'Bad Request'));
  server.on('connect', (request, clientSocket, head) => {
    void (async () => {
      if (!proxyAuthorized(request.headers['proxy-authorization'], token)) {
        endSocket(clientSocket, 407, 'Proxy Authentication Required', ['Proxy-Authenticate: Basic realm="open-kritt"']);
        return;
      }
      if (activeConnections >= maxConnections) {
        endSocket(clientSocket, 503, 'Service Unavailable');
        return;
      }

      activeConnections += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        activeConnections -= 1;
      };
      let upstream;
      let established = false;
      const lookupController = new AbortController();
      clientSocket.setTimeout(connectTimeoutMs, () => clientSocket.destroy());
      clientSocket.once('error', () => clientSocket.destroy());
      clientSocket.once('close', () => {
        lookupController.abort();
        upstream?.destroy();
        if (established) release();
      });
      try {
        const target = parseConnectTarget(request.url);
        const resolved = await resolvePublicTarget(target.hostname, lookup, dnsTimeoutMs, lookupController);
        if (clientSocket.destroyed) return;
        upstream = connect({ host: resolved.address, port: target.port, family: resolved.family });
        sockets.add(upstream);
        upstream.once('close', () => sockets.delete(upstream));
        if (clientSocket.destroyed) {
          upstream.destroy();
          return;
        }
        upstream.setTimeout(connectTimeoutMs, () => upstream.destroy());
        await new Promise((resolve, reject) => {
          let settled = false;
          const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            upstream.removeListener('connect', onConnect);
            upstream.removeListener('error', onError);
            upstream.removeListener('close', onClose);
            callback(value);
          };
          const onConnect = () => {
            finish(resolve);
            upstream.once('error', () => clientSocket.destroy());
            upstream.once('close', () => clientSocket.destroy());
          };
          const onError = (error) => {
            finish(reject, error);
          };
          const onClose = () => finish(reject, new Error('Upstream closed before CONNECT completed.'));
          upstream.once('connect', onConnect);
          upstream.once('error', onError);
          upstream.once('close', onClose);
        });
        if (clientSocket.destroyed || upstream.destroyed) {
          upstream.destroy();
          return;
        }
        established = true;
        upstream.setTimeout(0);
        clientSocket.setTimeout(0);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      } catch (error) {
        upstream?.destroy();
        const statusCode = error instanceof ConnectProxyError ? error.statusCode : 502;
        endSocket(
          clientSocket,
          statusCode,
          statusCode === 400 ? 'Bad Request' : statusCode === 403 ? 'Forbidden' : 'Bad Gateway'
        );
      } finally {
        if (!established) release();
      }
    })();
  });

  return {
    server,
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

async function main() {
  const bindHost = process.env.OPEN_KRITT_CONNECT_PROXY_BIND || '';
  const token = process.env.OPEN_KRITT_CONNECT_PROXY_TOKEN || '';
  if (!bindHost || !token) throw new Error('Missing proxy startup configuration.');
  const proxy = createConnectProxy({ token });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    proxy.server.once('error', onError);
    proxy.server.listen(0, bindHost, () => {
      proxy.server.removeListener('error', onError);
      resolve();
    });
  });
  const address = proxy.server.address();
  if (!address || typeof address === 'string') throw new Error('Could not determine the proxy listener address.');
  process.stdout.write(`${JSON.stringify({ type: 'ready', port: address.port })}\n`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    process.stdin.pause();
    await proxy.close();
  };
  proxy.server.on('error', () => {
    process.exitCode = 1;
    void shutdown();
  });
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.stdin.resume();
  process.stdin.once('end', () => void shutdown());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('Could not start the open-kritt CONNECT proxy.\n');
    process.exitCode = 1;
  });
}
