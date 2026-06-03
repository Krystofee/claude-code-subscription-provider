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

## Pi provider: `claude-code-subscription-provider`

Repo je zároveň installable jako pi package a obsahuje project-local pi extension:

- `.pi/extensions/claude-code-subscription-provider/index.ts`

Co dělá:

- registruje sadu modelů (pi id → Anthropic id):
  - `claude-code-subscription-provider/opus-4-8` → `claude-opus-4-8`
  - `claude-code-subscription-provider/opus-4-7` → `claude-opus-4-7`
  - `claude-code-subscription-provider/opus-4-6` → `claude-opus-4-6`
  - `claude-code-subscription-provider/sonnet-4-6` → `claude-sonnet-4-6` (256k — subscription tier nemá 1M na Sonnetu)
- pro requesty používá Anthropic Messages API a u všech modelů vynutí adaptive thinking (`compat.forceAdaptiveThinking`)
- `thinkingLevelMap` kopíruje nativní pi-ai katalog: Opus 4.6 mapuje `xhigh → "max"`, Opus 4.7/4.8 `xhigh → "xhigh"`, Sonnet 4.6 jede na defaultu
- pro Opus 4.7/4.8 automaticky nastaví `thinking.display = "summarized"` (defaultně skrývají thinking text, což by v UI vypadalo jako prázdná pauza před odpovědí); Opus 4.6 a Sonnet 4.6 thinking ukazují nativně
- access token získá přes lokálně spuštěný `claude` (Claude Code) a MITM capture (probe běží na `claude-opus-4-8`)
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

Pak v pi (vyber libovolný model ze sady):

```text
/model claude-code-subscription-provider/opus-4-8
/model claude-code-subscription-provider/opus-4-7
/model claude-code-subscription-provider/opus-4-6
/model claude-code-subscription-provider/sonnet-4-6   # 256k context
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
