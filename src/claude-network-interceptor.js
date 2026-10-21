#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const zlib = require('zlib');
const { Proxy } = require('http-mitm-proxy');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8899,
  caDir: '.claude-interceptor-ca',
  logDir: 'logs',
  envFile: '.claude-interceptor.env',
  bodyLimitBytes: 1024 * 1024,
  redact: true,
  quiet: false,
};

function printHelp() {
  console.log(`Claude Code network interceptor

Usage:
  node src/claude-network-interceptor.js
  node src/claude-network-interceptor.js --exec claude -- --print "Hello world"

Options:
  --host <host>                Proxy bind host (default: 127.0.0.1)
  --port <port>                Proxy port (default: 8899)
  --ca-dir <dir>               Directory for generated CA (default: .claude-interceptor-ca)
  --log-dir <dir>              Directory for logs (default: logs)
  --env-file <path>            Shell exports file for sidecar mode (default: .claude-interceptor.env)
  --body-limit-bytes <bytes>   Max stored bytes per request/response body (default: 1048576)
  --no-redact                  Store raw headers and bodies (may contain credentials)
  --quiet                      Less console output
  --exec <command>             Execute command through the proxy; trailing args go after --
  --help                       Show this help

Examples:
  npm run interceptor
  npm run demo:hello
  node src/claude-network-interceptor.js --exec claude -- --print "Hello world"
`);
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, execCommand: null, execArgs: [] };
  let i = 0;
  let afterDoubleDash = false;

  while (i < argv.length) {
    const arg = argv[i];

    if (afterDoubleDash) {
      options.execArgs.push(arg);
      i += 1;
      continue;
    }

    if (arg === '--') {
      afterDoubleDash = true;
      i += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      i += 1;
      continue;
    }

    if (arg === '--host') {
      options.host = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === '--port') {
      options.port = Number(argv[i + 1]);
      i += 2;
      continue;
    }

    if (arg === '--ca-dir') {
      options.caDir = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === '--log-dir') {
      options.logDir = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === '--env-file') {
      options.envFile = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === '--body-limit-bytes') {
      options.bodyLimitBytes = Number(argv[i + 1]);
      i += 2;
      continue;
    }

    if (arg === '--exec') {
      options.execCommand = argv[i + 1];
      i += 2;
      continue;
    }

    if (arg === '--no-redact') {
      options.redact = false;
      i += 1;
      continue;
    }

    if (arg === '--quiet') {
      options.quiet = true;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.host) throw new Error('--host is required');
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('--port must be between 0 and 65535');
  if (!Number.isInteger(options.bodyLimitBytes) || options.bodyLimitBytes <= 0) {
    throw new Error('--body-limit-bytes must be a positive integer');
  }

  return options;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(dirPath, 0o700);
}

function writePrivateFile(filePath, content, append = false) {
  fs.writeFileSync(filePath, content, { mode: 0o600, flag: append ? 'a' : 'w' });
  fs.chmodSync(filePath, 0o600);
}

function isSecretField(key) {
  return /^(accessToken|refreshToken|idToken|token|apiKey|anthropicApiKey|clientSecret|password|authorization|cookie|setCookie)$/i.test(String(key).replace(/[^a-z]/gi, ''));
}

function redactText(text, enabled = true) {
  if (!enabled) return text;
  return text
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-ant-[a-z0-9_-]+/gi, '[REDACTED]')
    // Also handle malformed/truncated JSON and JSON embedded in SSE frames.
    .replace(/("(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|client[_-]?secret|password|authorization)"\s*:\s*")(?:[^"\\]|\\.)*("|$)/gi, '$1[REDACTED]$2');
}

function redactJson(value) {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, isSecretField(key) ? '[REDACTED]' : redactJson(item)]));
  }
  return typeof value === 'string' ? redactText(value) : value;
}

function redactUrl(value, enabled = true) {
  if (!enabled) return value;
  try {
    const absolute = /^https?:\/\//i.test(value);
    const url = new URL(value, 'http://redaction.invalid');
    for (const key of url.searchParams.keys()) {
      if (isSecretField(key)) url.searchParams.set(key, '[REDACTED]');
    }
    if (url.username) url.username = '[REDACTED]';
    if (url.password) url.password = '[REDACTED]';
    return redactText(absolute ? url.toString() : url.pathname + url.search);
  } catch { return redactText(value); }
}

function isoNow() {
  return new Date().toISOString();
}

function appendNdjson(filePath, payload) {
  writePrivateFile(filePath, `${JSON.stringify(payload)}\n`, true);
}

function redactHeaders(headers, enabled) {
  const result = {};
  const secretHeaderNames = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'anthropic-api-key',
  ]);

  for (const [key, value] of Object.entries(headers || {})) {
    if (enabled && (secretHeaderNames.has(String(key).toLowerCase()) || isSecretField(key) || /(?:^|-)token$/i.test(key))) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = typeof value === 'string' ? redactText(value, enabled) : value;
    }
  }

  return result;
}

function pushChunk(bucket, chunk, limitBytes) {
  bucket.rawBytes += chunk.length;

  if (bucket.storedBytes >= limitBytes) {
    bucket.truncated = true;
    return;
  }

  const remaining = limitBytes - bucket.storedBytes;
  const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  bucket.chunks.push(Buffer.from(slice));
  bucket.storedBytes += slice.length;

  if (slice.length < chunk.length) {
    bucket.truncated = true;
  }
}

function isLikelyText(contentType) {
  if (!contentType) return true;
  const value = String(contentType).toLowerCase();
  return (
    value.includes('json') ||
    value.includes('text/') ||
    value.includes('javascript') ||
    value.includes('xml') ||
    value.includes('yaml') ||
    value.includes('x-www-form-urlencoded') ||
    value.includes('event-stream')
  );
}

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  return value == null ? '' : String(value);
}

function maybeDecompress(buffer, contentEncoding, limitBytes) {
  const encoding = normalizeHeaderValue(contentEncoding).toLowerCase().trim();
  if (!encoding || encoding === 'identity') {
    return { buffer, decompressed: false, encoding };
  }

  try {
    if (encoding.includes('gzip')) {
      return { buffer: zlib.gunzipSync(buffer, { maxOutputLength: limitBytes }), decompressed: true, encoding };
    }
    if (encoding.includes('deflate')) {
      return { buffer: zlib.inflateSync(buffer, { maxOutputLength: limitBytes }), decompressed: true, encoding };
    }
    if (encoding.includes('br')) {
      return { buffer: zlib.brotliDecompressSync(buffer, { maxOutputLength: limitBytes }), decompressed: true, encoding };
    }
  } catch (error) {
    return {
      buffer,
      decompressed: false,
      encoding,
      decompressionError: error.message,
    };
  }

  return { buffer, decompressed: false, encoding, decompressionError: `Unsupported content encoding: ${encoding}` };
}

function summarizeBody(buffer, headers, truncated, redact = true, limitBytes = DEFAULTS.bodyLimitBytes) {
  const contentType = normalizeHeaderValue(headers?.['content-type']);
  const contentEncoding = normalizeHeaderValue(headers?.['content-encoding']);
  const { buffer: processedBuffer, decompressed, decompressionError } = maybeDecompress(buffer, contentEncoding, limitBytes);
  const textLike = isLikelyText(contentType);

  const summary = {
    capturedBytes: buffer.length,
    contentType: contentType || null,
    contentEncoding: contentEncoding || null,
    truncated,
    decompressed,
  };

  if (decompressionError) {
    summary.decompressionError = decompressionError;
  }

  if (redact && (!textLike || decompressionError)) {
    summary.format = 'text';
    summary.preview = summary.fullText = '[BODY OMITTED: cannot safely redact]';
    return summary;
  }

  if (textLike) {
    let text = processedBuffer.toString('utf8');
    summary.format = 'text';

    if (contentType.toLowerCase().includes('json')) {
      try {
        const parsed = JSON.parse(text);
        text = JSON.stringify(redact ? redactJson(parsed) : parsed, null, 2);
        summary.format = 'json';
      } catch {
        summary.format = 'text';
      }
    }

    if (redact && contentType.includes('x-www-form-urlencoded')) {
      const fields = new URLSearchParams(text);
      for (const key of fields.keys()) if (isSecretField(key)) fields.set(key, '[REDACTED]');
      text = fields.toString();
    }
    text = redactText(text, redact);
    summary.preview = text.length > 4000 ? `${text.slice(0, 4000)}\n…[truncated preview]` : text;
    summary.fullText = text;
    return summary;
  }

  summary.format = 'base64';
  const base64 = processedBuffer.toString('base64');
  summary.preview = base64.length > 4000 ? `${base64.slice(0, 4000)}\n…[truncated preview]` : base64;
  summary.fullText = base64;
  return summary;
}

function safeFilePart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function bodyExtension(summary) {
  if (summary.format === 'json') return 'json';
  if (summary.format === 'text') return 'txt';
  return 'base64.txt';
}

function writeBodyFile(baseDir, id, direction, summary) {
  const ext = bodyExtension(summary);
  const fileName = `${safeFilePart(id)}-${direction}.${ext}`;
  const filePath = path.join(baseDir, fileName);
  writePrivateFile(filePath, summary.fullText || '');
  return filePath;
}

function buildEnvFileContent({ host, port, caPath }) {
  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  return `# Generated by claude-network-interceptor\nexport HTTP_PROXY=${quote(`http://${host}:${port}`)}\nexport HTTPS_PROXY=${quote(`http://${host}:${port}`)}\nexport NODE_EXTRA_CA_CERTS=${quote(caPath)}\n`;
}

function logConsole(enabled, message) {
  if (!enabled) return;
  process.stdout.write(`${message}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const caDir = path.resolve(options.caDir);
  const logDir = path.resolve(options.logDir);
  const bodiesDir = path.join(logDir, 'bodies');
  const envFilePath = path.resolve(options.envFile);
  const eventsFile = path.join(logDir, 'events.ndjson');
  const transactionsFile = path.join(logDir, 'transactions.ndjson');

  ensureDir(caDir);
  ensureDir(logDir);
  ensureDir(bodiesDir);

  const proxy = new Proxy();
  let sequence = 0;
  let shuttingDown = false;

  function writeEvent(payload) {
    appendNdjson(eventsFile, payload);
  }

  function shutdown(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      proxy.close();
    } catch {}
    process.exit(exitCode);
  }

  proxy.onError((ctx, error, errorKind) => {
    const requestId = ctx?.__requestMeta?.id || null;
    const message = redactText(error?.message || String(error), options.redact);
    writeEvent({
      type: 'proxy_error',
      at: isoNow(),
      requestId,
      errorKind,
      message,
    });

    logConsole(!options.quiet, `[error] ${errorKind}${requestId ? ` (${requestId})` : ''}: ${message}`);
  });

  proxy.onConnect((req, socket, head, callback) => {
    writeEvent({
      type: 'connect',
      at: isoNow(),
      target: redactUrl(req.url, options.redact),
      headers: redactHeaders(req.headers || {}, options.redact),
    });
    callback();
  });

  proxy.onRequest((ctx, callback) => {
    const id = `${Date.now()}-${String(++sequence).padStart(4, '0')}`;
    const startedAt = Date.now();
    const startedAtIso = isoNow();
    const reqHeaders = redactHeaders(ctx.clientToProxyRequest.headers || {}, options.redact);
    const reqBucket = { chunks: [], rawBytes: 0, storedBytes: 0, truncated: false };
    const resBucket = { chunks: [], rawBytes: 0, storedBytes: 0, truncated: false };

    const meta = {
      id,
      startedAt,
      startedAtIso,
      method: ctx.clientToProxyRequest.method,
      host: ctx.clientToProxyRequest.headers.host,
      path: redactUrl(ctx.clientToProxyRequest.url, options.redact),
      protocol: ctx.isSSL ? 'https' : 'http',
      requestHeaders: reqHeaders,
      reqBucket,
      resBucket,
    };

    ctx.__requestMeta = meta;

    writeEvent({
      type: 'request_started',
      at: startedAtIso,
      id,
      method: meta.method,
      url: `${meta.protocol}://${meta.host}${meta.path}`,
    });

    ctx.onRequestData((innerCtx, chunk, cb) => {
      pushChunk(reqBucket, chunk, options.bodyLimitBytes);
      cb(null, chunk);
    });

    ctx.onRequestEnd((innerCtx, cb) => {
      meta.requestEndedAt = isoNow();
      cb();
    });

    ctx.onResponseData((innerCtx, chunk, cb) => {
      pushChunk(resBucket, chunk, options.bodyLimitBytes);
      cb(null, chunk);
    });

    ctx.onResponseEnd((innerCtx, cb) => {
      const finishedAt = Date.now();
      const responseHeaders = redactHeaders(innerCtx.serverToProxyResponse?.headers || {}, options.redact);
      const requestBodySummary = summarizeBody(Buffer.concat(reqBucket.chunks), meta.requestHeaders, reqBucket.truncated, options.redact, options.bodyLimitBytes);
      const responseBodySummary = summarizeBody(Buffer.concat(resBucket.chunks), responseHeaders, resBucket.truncated, options.redact, options.bodyLimitBytes);
      const requestBodyFile = writeBodyFile(bodiesDir, id, 'request', requestBodySummary);
      const responseBodyFile = writeBodyFile(bodiesDir, id, 'response', responseBodySummary);

      const record = {
        id,
        startedAt: startedAtIso,
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs: finishedAt - startedAt,
        protocol: meta.protocol,
        request: {
          method: meta.method,
          host: meta.host,
          path: meta.path,
          url: `${meta.protocol}://${meta.host}${meta.path}`,
          headers: meta.requestHeaders,
          rawBytes: reqBucket.rawBytes,
          storedBytes: reqBucket.storedBytes,
          body: {
            ...requestBodySummary,
            file: path.relative(process.cwd(), requestBodyFile),
          },
        },
        response: {
          statusCode: innerCtx.serverToProxyResponse?.statusCode ?? null,
          statusMessage: innerCtx.serverToProxyResponse?.statusMessage ?? null,
          headers: responseHeaders,
          rawBytes: resBucket.rawBytes,
          storedBytes: resBucket.storedBytes,
          body: {
            ...responseBodySummary,
            file: path.relative(process.cwd(), responseBodyFile),
          },
        },
      };

      appendNdjson(transactionsFile, record);

      logConsole(
        !options.quiet,
        `[${record.response.statusCode ?? '???'} ${record.durationMs}ms] ${record.request.method} ${record.request.url}`
      );

      cb();
    });

    callback();
  });

  await new Promise((resolve, reject) => {
    proxy.listen(
      {
        host: options.host,
        port: options.port,
        sslCaDir: caDir,
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      }
    );
  });

  options.port = proxy.httpPort;
  const caPath = path.join(caDir, 'certs', 'ca.pem');
  const envFileContent = buildEnvFileContent({ host: options.host, port: options.port, caPath });
  writePrivateFile(envFilePath, envFileContent);

  logConsole(!options.quiet, `Proxy listening on http://${options.host}:${options.port}`);
  logConsole(!options.quiet, `CA certificate: ${caPath}`);
  logConsole(!options.quiet, `Env exports: ${envFilePath}`);
  logConsole(!options.quiet, `Logs: ${logDir}`);
  logConsole(!options.quiet, `Transactions: ${transactionsFile}`);

  writeEvent({
    type: 'proxy_started',
    at: isoNow(),
    host: options.host,
    port: options.port,
    caPath,
    envFile: envFilePath,
    logDir,
  });

  if (!options.execCommand) {
    logConsole(!options.quiet, '');
    logConsole(!options.quiet, 'Sidecar mode:');
    logConsole(!options.quiet, `  source ${envFilePath}`);
    logConsole(!options.quiet, '  claude -p "Hello world"');
    logConsole(!options.quiet, '');
    logConsole(!options.quiet, 'Press Ctrl+C to stop the interceptor.');

    process.on('SIGINT', () => shutdown(0));
    process.on('SIGTERM', () => shutdown(0));
    return;
  }

  const childEnv = {
    ...process.env,
    HTTP_PROXY: `http://${options.host}:${options.port}`,
    HTTPS_PROXY: `http://${options.host}:${options.port}`,
    NODE_EXTRA_CA_CERTS: caPath,
  };

  logConsole(
    !options.quiet,
    `Executing: ${[options.execCommand, ...options.execArgs].map((part) => JSON.stringify(part)).join(' ')}`
  );

  const child = spawn(options.execCommand, options.execArgs, {
    stdio: 'inherit',
    env: childEnv,
  });

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  child.on('error', (error) => {
    logConsole(!options.quiet, `Unable to execute ${options.execCommand}: ${error.code || 'spawn failed'}`);
    shutdown(1);
  });

  child.on('exit', (code, signal) => {
    writeEvent({
      type: 'exec_finished',
      at: isoNow(),
      command: options.execCommand,
      args: options.execArgs.map((arg) => redactText(arg, options.redact)),
      code,
      signal,
    });

    try {
      proxy.close();
    } catch {}

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

async function closeCaptureProxy(proxy) {
  // Per-host HTTPS servers may finish starting after proxy.close() has run.
  for (let attempt = 0; attempt < 5; attempt++) {
    const servers = [proxy.httpServer, proxy.httpsServer];
    const sockets = [proxy.wsServer, proxy.wssServer];
    for (const entry of Object.values(proxy.sslServers || {})) {
      servers.push(entry.server);
      sockets.push(entry.wsServer);
    }
    for (const socket of sockets.filter(Boolean)) {
      for (const client of socket.clients || []) client.terminate();
      try { socket.close(); } catch {}
    }
    for (const server of servers.filter(Boolean)) {
      try { server.close(); server.closeAllConnections?.(); } catch {}
    }
    proxy.httpAgent?.destroy();
    proxy.httpsAgent?.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function captureClaudeCodeToken(model, signal) {
  signal?.throwIfAborted();
  const caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-claude-code-subscription-provider-ca-'));
  const proxy = new Proxy();
  let child;
  let stopChildTimer;
  let timer;
  let onAbort;
  let finished = false;
  try {
    return await new Promise((resolve, reject) => {
      onAbort = () => reject(signal.reason || new Error('Token capture aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => reject(new Error('Claude Code token capture timed out')), 90_000);
      proxy.onError(() => {});
      proxy.onRequest((ctx, callback) => {
        const headers = ctx.clientToProxyRequest.headers;
        if (headers.host === 'api.anthropic.com' && ctx.clientToProxyRequest.url.startsWith('/v1/messages') && headers.authorization?.startsWith('Bearer ')) {
          resolve({
            accessToken: headers.authorization.slice(7),
            anthropicBeta: headers['anthropic-beta'],
            userAgent: headers['user-agent'],
            xApp: headers['x-app'],
          });
          // Capturing headers is enough; don't bill a throwaway model request.
          ctx.proxyToClientResponse.writeHead(503, { 'content-type': 'application/json' });
          ctx.proxyToClientResponse.end('{"error":{"type":"api_error","message":"Auth capture complete"}}');
          return;
        }
        callback();
      });
      proxy.listen({ host: '127.0.0.1', port: 0, sslCaDir: caDir }, (error) => {
        if (finished) {
          closeCaptureProxy(proxy).finally(() => fs.rmSync(caDir, { recursive: true, force: true })).catch(() => {});
          return;
        }
        if (error) { reject(error); return; }
        if (signal?.aborted) { onAbort(); return; }
        const proxyUrl = `http://127.0.0.1:${proxy.httpPort}`;
        child = spawn('claude', [
          '--model', model, '--print', 'Reply with exactly OK.',
          '--no-session-persistence', '--setting-sources', '', '--disable-slash-commands', '--tools', '',
          '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        ], {
          cwd: caDir,
          stdio: ['ignore', 'ignore', 'ignore'],
          env: {
            ...process.env,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl,
            http_proxy: proxyUrl, https_proxy: proxyUrl,
            NO_PROXY: '', no_proxy: '',
            NODE_EXTRA_CA_CERTS: path.join(caDir, 'certs', 'ca.pem'),
          },
        });
        child.on('error', reject);
        child.on('exit', (code) => reject(new Error(`Claude Code exited before token capture (${code})`)));
      });
    });
  } finally {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (child && child.exitCode == null && child.signalCode == null) {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        stopChildTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
        child.kill('SIGTERM');
      });
      clearTimeout(stopChildTimer);
    }
    await closeCaptureProxy(proxy);
    fs.rmSync(caDir, { recursive: true, force: true });
  }
}

module.exports = { redactHeaders, redactUrl, summarizeBody, writeBodyFile, buildEnvFileContent, captureClaudeCodeToken };

if (require.main === module) {
  if (process.argv[2] === '--capture-token') {
    // Silence only this isolated worker, never the parent Pi process.
    console.log = console.info = console.debug = () => {};
    const controller = new AbortController();
    process.once('SIGTERM', () => controller.abort());
    process.once('SIGINT', () => controller.abort());
    const modelIndex = process.argv.indexOf('--model');
    // Exit explicitly: http-mitm-proxy orphans a per-host server on parallel CONNECTs, keeping the loop alive.
    captureClaudeCodeToken(modelIndex < 0 ? 'claude-opus-4-8' : process.argv[modelIndex + 1], controller.signal)
      .then((bundle) => process.stdout.write(`${JSON.stringify(bundle)}\n`, () => process.exit(0)))
      .catch(() => process.exit(1));
  } else {
    main().catch((error) => {
      console.error(error.stack || error.message || String(error));
      process.exit(1);
    });
  }
}
