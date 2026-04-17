# Claude Code network interceptor

Lokální MITM proxy pro `claude` / Claude Code, která funguje i se **subscription auth**.

- nevyžaduje `ANTHROPIC_API_KEY`
- zachytí requesty přes `HTTPS_PROXY`
- vygeneruje vlastní CA a předá ji Claude přes `NODE_EXTRA_CA_CERTS`
- ukládá request/response hlavičky i těla do souborů
- umí běžet jako **sidecar** nebo rovnou spustit `claude`

## Instalace

```bash
npm install
```

## Rychlý test

```bash
npm run demo:hello
```

To spustí interceptor a přes něj:

```bash
claude --print "Hello world"
```

## Sidecar režim

Terminál A:

```bash
npm run interceptor
```

Interceptor vypíše cestu k env souboru, typicky:

```bash
source /.../.claude-interceptor.env
claude -p "Hello world"
```

Terminál B:

```bash
source ./.claude-interceptor.env
claude -p "Hello world"
```

## Logy

Vše se ukládá do `logs/`:

- `logs/transactions.ndjson` – jedna HTTP transakce na řádek
- `logs/events.ndjson` – connect/error/start eventy
- `logs/bodies/` – request/response těla

## Co v logu uvidíš

Např. pro `claude -p "Hello world"` jsem ověřil requesty na:

- `https://api.anthropic.com/v1/messages?beta=true`
- `https://api.anthropic.com/v1/mcp_servers?limit=1000`
- `https://ui.sh/mcp?agent=claude`
- `https://mcp-proxy.anthropic.com/...`
- `https://downloads.claude.ai/...`
- `https://http-intake.logs.us5.datadoghq.com/api/v2/logs`

## Poznámky

- Hlavičky jako `Authorization` jsou defaultně redigované.
- Pokud chceš vidět i secrety, spusť s `--no-redact`.
- Těla se ukládají maximálně do velikosti `--body-limit-bytes` na request/response.

## Pi provider: `claude-code-subscription-provider/opus-4-7`

Repo je zároveň installable jako pi package a obsahuje project-local pi extension:

- `.pi/extensions/claude-code-subscription-provider/index.ts`

Co dělá:

- registruje model `claude-code-subscription-provider/opus-4-7`
- pro requesty používá Anthropic Messages API
- pro `claude-opus-4-7` zachovává native adaptive effort levels (`high`, `xhigh`, `max`) a nepřemapovává `xhigh` na `max`
- pro `claude-opus-4-7` automaticky nastaví `thinking.display = "summarized"` (Opus 4.7 defaultně skrývá thinking text, což by v UI vypadalo jako prázdná pauza před odpovědí)
- access token získá přes lokálně spuštěný `claude` (Claude Code) a MITM capture
- token ukládá do `~/.pi/agent/cache/claude-code-subscription-provider.json`
- při neplatném cached tokenu udělá refresh a request zopakuje
- když Claude Code není přihlášené, vypíše instrukci k `claude auth login --claudeai`

Instalace user-level z repozitáře:

```bash
pi install git:git@github.com:Krystofee/claude-code-subscription-provider.git
```

Použití v pi:

```bash
pi
```

Pak v pi:

```text
/model claude-code-subscription-provider/opus-4-7
```

Volitelně lze zkontrolovat nebo refreshnout cache:

```text
/claude-code-auth
/claude-code-auth refresh
```

## Příklady

Spustit jen proxy:

```bash
node src/claude-network-interceptor.js
```

Spustit přímo Claude přes proxy:

```bash
node src/claude-network-interceptor.js --exec claude -- --print "Hello world"
```
