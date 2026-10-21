const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { redactHeaders, redactUrl, summarizeBody, writeBodyFile, buildEnvFileContent } = require('./claude-network-interceptor.js');
const execute = promisify(execFile);
const script = path.join(__dirname, 'claude-network-interceptor.js');

function summarize(text, contentType = 'application/json', redact = true, truncated = false) {
  return summarizeBody(Buffer.from(text), { 'content-type': contentType }, truncated, redact);
}

test('redacts credentials in headers, nested JSON, URL parameters, form data and SSE', () => {
  const headers = redactHeaders({ authorization: 'Bearer SECRET', 'x-auth-token': 'SECRET', 'user-agent': 'ordinary' }, true);
  assert.equal(headers.authorization, '[REDACTED]');
  assert.equal(headers['x-auth-token'], '[REDACTED]');
  assert.equal(headers['user-agent'], 'ordinary');
  const body = summarize(JSON.stringify({ access_token: 'SECRET', nested: [{ refreshToken: 'SECRET' }], text: 'Use sk-ant-oat-SECRET', nonsecret: 'Keep this' }));
  assert.ok(!body.fullText.includes('SECRET'));
  assert.ok(body.fullText.includes('Keep this'));
  assert.ok(!summarize('access_token=SECRET&message=keep', 'application/x-www-form-urlencoded').fullText.includes('SECRET'));
  assert.ok(!summarize('data: {"refresh_token":"SECRET"}\n\n', 'text/event-stream').fullText.includes('SECRET'));
  assert.ok(!redactUrl('/oauth?access_token=SECRET&state=keep').includes('SECRET'));
});

test('redacts truncated JSON and omits binary or undecodable bodies unless explicitly requested', () => {
  assert.ok(!summarize('{"refresh_token":"SECRET', 'application/json', true, true).fullText.includes('SECRET'));
  assert.match(summarize('SECRET', 'application/octet-stream').fullText, /OMITTED/);
  assert.match(summarize('{"access_token":"SECRET"}', 'application/json', false).fullText, /SECRET/);
  const compressed = zlib.gzipSync(Buffer.from('x'.repeat(10000)));
  const body = summarizeBody(compressed, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }, false, true, 100);
  assert.match(body.fullText, /OMITTED/);
});

test('body files use private permissions, including when replacing an existing file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-log-test-'));
  try {
    const file = writeBodyFile(directory, 'fixture', 'response', summarize('{"access_token":"SECRET"}'));
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.ok(!(await fs.readFile(file, 'utf8')).includes('SECRET'));
    await fs.chmod(file, 0o644);
    writeBodyFile(directory, 'fixture', 'response', summarize('{}'));
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('sidecar exports quote paths with spaces and apostrophes correctly', async () => {
  const caPath = "/tmp/CA's directory/cert.pem";
  const content = buildEnvFileContent({ host: '127.0.0.1', port: 8899, caPath });
  const { stdout } = await execute('/bin/sh', ['-c', `${content}\nprintf '%s' "$NODE_EXTRA_CA_CERTS"`]);
  assert.equal(stdout, caPath);
});

async function fakeClaude(directory, source) {
  const file = path.join(directory, 'claude');
  await fs.writeFile(file, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, TMPDIR: directory };
}

test('capture worker intercepts parallel TLS requests locally, emits only the token bundle, exits and cleans its CA', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-capture-test-'));
  try {
    const env = await fakeClaude(directory, `
      const http = require('node:http');
      const tls = require('node:tls');
      const fs = require('node:fs');
      const proxy = new URL(process.env.HTTPS_PROXY);
      for (let i = 0; i < 2; i++) {
        const request = http.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: 'api.anthropic.com:443' });
        request.on('connect', (_response, socket) => {
          const secure = tls.connect({ socket, servername: 'api.anthropic.com', ca: fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS) }, () => {
            secure.write('POST /v1/messages HTTP/1.1\\r\\nHost: api.anthropic.com\\r\\nAuthorization: Bearer sk-ant-oat-TEST-FIXTURE\\r\\nUser-Agent: claude-cli/2.1.280\\r\\nContent-Length: 2\\r\\n\\r\\n{}');
          });
          secure.on('error', () => {});
          secure.resume();
        });
        request.end();
      }
    `);
    const { stdout } = await execute(process.execPath, [script, '--capture-token'], { env, timeout: 15000, killSignal: 'SIGKILL' });
    const bundle = JSON.parse(stdout);
    assert.equal(bundle.accessToken, 'sk-ant-oat-TEST-FIXTURE');
    assert.equal(bundle.userAgent, 'claude-cli/2.1.280');
    assert.deepEqual(await fs.readdir(directory), ['claude']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('capture worker cancellation kills the probe and removes the generated CA', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-capture-abort-test-'));
  let worker;
  try {
    const pidFile = path.join(directory, 'probe.pid');
    const env = await fakeClaude(directory, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    worker = spawn(process.execPath, [script, '--capture-token'], { env, stdio: 'ignore' });
    const exited = once(worker, 'exit');
    const deadline = Date.now() + 10000;
    while (true) {
      try { await fs.access(pidFile); break; }
      catch { if (Date.now() > deadline) throw new Error('probe did not start'); await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    worker.kill('SIGTERM');
    await exited;
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['claude', 'probe.pid']);
  } finally {
    if (worker && worker.exitCode == null && worker.signalCode == null) worker.kill('SIGKILL');
    await fs.rm(directory, { recursive: true, force: true });
  }
});
