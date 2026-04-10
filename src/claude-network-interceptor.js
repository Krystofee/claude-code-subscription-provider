#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
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
  --no-redact                  Do not redact Authorization/Cookie headers
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
  if (!Number.isInteger(options.port) || options.port <= 0) throw new Error('--port must be a positive integer');
  if (!Number.isInteger(options.bodyLimitBytes) || options.bodyLimitBytes <= 0) {
    throw new Error('--body-limit-bytes must be a positive integer');
  }

  return options;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isoNow() {
  return new Date().toISOString();
}

function appendNdjson(filePath, payload) {
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
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
    if (enabled && secretHeaderNames.has(String(key).toLowerCase())) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = value;
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

function maybeDecompress(buffer, contentEncoding) {
  const encoding = normalizeHeaderValue(contentEncoding).toLowerCase().trim();
  if (!encoding || encoding === 'identity') {
    return { buffer, decompressed: false, encoding };
  }

  try {
    if (encoding.includes('gzip')) {
      return { buffer: zlib.gunzipSync(buffer), decompressed: true, encoding };
    }
    if (encoding.includes('deflate')) {
      return { buffer: zlib.inflateSync(buffer), decompressed: true, encoding };
    }
    if (encoding.includes('br')) {
      return { buffer: zlib.brotliDecompressSync(buffer), decompressed: true, encoding };
    }
  } catch (error) {
    return {
      buffer,
      decompressed: false,
      encoding,
      decompressionError: error.message,
    };
  }

  return { buffer, decompressed: false, encoding };
}

function summarizeBody(buffer, headers, truncated) {
  const contentType = normalizeHeaderValue(headers?.['content-type']);
  const contentEncoding = normalizeHeaderValue(headers?.['content-encoding']);
  const { buffer: processedBuffer, decompressed, decompressionError } = maybeDecompress(buffer, contentEncoding);
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

  if (textLike) {
    let text = processedBuffer.toString('utf8');
    summary.format = 'text';

    if (contentType.toLowerCase().includes('json')) {
      try {
        const parsed = JSON.parse(text);
        text = JSON.stringify(parsed, null, 2);
        summary.format = 'json';
      } catch {
        summary.format = 'text';
      }
    }

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
  fs.writeFileSync(filePath, summary.fullText || '');
  return filePath;
}

function buildEnvFileContent({ host, port, caPath }) {
  return `# Generated by claude-network-interceptor\nexport HTTP_PROXY=http://${host}:${port}\nexport HTTPS_PROXY=http://${host}:${port}\nexport NODE_EXTRA_CA_CERTS=${caPath}\n`;
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
    writeEvent({
      type: 'proxy_error',
      at: isoNow(),
      requestId,
      errorKind,
      message: error?.message || String(error),
    });

    logConsole(!options.quiet, `[error] ${errorKind}${requestId ? ` (${requestId})` : ''}: ${error?.message || error}`);
  });

  proxy.onConnect((req, socket, head, callback) => {
    writeEvent({
      type: 'connect',
      at: isoNow(),
      target: req.url,
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
      path: ctx.clientToProxyRequest.url,
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
      const requestBodySummary = summarizeBody(Buffer.concat(reqBucket.chunks), meta.requestHeaders, reqBucket.truncated);
      const responseBodySummary = summarizeBody(Buffer.concat(resBucket.chunks), responseHeaders, resBucket.truncated);
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

  const caPath = path.join(caDir, 'certs', 'ca.pem');
  const envFileContent = buildEnvFileContent({ host: options.host, port: options.port, caPath });
  fs.writeFileSync(envFilePath, envFileContent);

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

  child.on('exit', (code, signal) => {
    writeEvent({
      type: 'exec_finished',
      at: isoNow(),
      command: options.execCommand,
      args: options.execArgs,
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

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
