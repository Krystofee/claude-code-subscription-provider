# Claude Code network interceptor

Lokální MITM proxy pro `claude` / Claude Code, která funguje i se **subscription auth**.

- nevyžaduje `ANTHROPIC_API_KEY`
- zachytí requesty přes `HTTPS_PROXY`
- vygeneruje vlastní CA a předá ji Claude přes `NODE_EXTRA_CA_CERTS`
- ukládá request/response hlavičky i těla do souborů
- umí běžet jako **sidecar** nebo rovnou spustit `claude`

## Instalace

Vyžaduje Node.js 22.19+ a Pi 1.1+. Vývojové testy běží proti Pi 1.2;
Pi balíčky jsou peer dependencies, za běhu se používá API hostujícího Pi.

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

- Credentials se defaultně redigují v hlavičkách, URL parametrech i JSON/form tělech. Binární nebo nedekódovatelná těla se vynechávají.
- Log adresáře mají práva `0700`, soubory `0600`. Redakce credentials neanonymizuje ostatní osobní data v promptech.
- `--no-redact` ukládá i raw credentials; takové logy nesdílej ani necommituj.
- Těla se ukládají maximálně do velikosti `--body-limit-bytes` na request/response.

## Pi provider: `claude-code-subscription-provider`

Repo je zároveň installable jako pi package a obsahuje project-local pi extension:

- `.pi/extensions/claude-code-subscription-provider/index.ts`

Co dělá:

- registruje sadu modelů (pi id → Anthropic id):
  - `claude-code-subscription-provider/opus-5-5` → `claude-opus-5-5`
  - `claude-code-subscription-provider/opus-5` → `claude-opus-5`
  - `claude-code-subscription-provider/opus-4-8` → `claude-opus-4-8`
  - `claude-code-subscription-provider/opus-4-7` → `claude-opus-4-7`
  - `claude-code-subscription-provider/opus-4-6` → `claude-opus-4-6`
  - `claude-code-subscription-provider/sonnet-4-6` → `claude-sonnet-4-6` (256k — subscription tier nemá 1M na Sonnetu)
  - `claude-code-subscription-provider/fable-5-1` → `claude-fable-5-1`
  - `claude-code-subscription-provider/fable-5` → `claude-fable-5`
- 1M long-context beta (`context-1m-2025-08-07`) posílá jen u modelů s 1M oknem (Opus a Fable). U Sonnetu se vynechává — jinak Anthropic vrací 429 `Usage credits are required for long context requests` i na malém promptu.
- pro requesty používá Anthropic Messages API a u všech modelů vynutí adaptive thinking (`compat.forceAdaptiveThinking`)
- ceny, thinking levels (včetně `max`), replay pravidla a cache lifetimes kopíruje nativní pi-ai katalog; subscription context limity zůstávají explicitní
- user agent se normalizuje minimálně na `claude-cli/2.1.280` — Opus 5.5 na starších verzích vrací 400 `claude_code_version_too_old`
- pro Opus 4.7+ a Fable 5+ automaticky nastaví `thinking.display = "summarized"` (defaultně skrývají thinking text, což by v UI vypadalo jako prázdná pauza před odpovědí); Opus 4.6 a Sonnet 4.6 thinking ukazují nativně
- access token získá přes lokálně spuštěný `claude` (Claude Code) a MITM capture v izolovaném workeru; probe má vypnuté MCP, tools, skills i nastavení a zachycený model request se neposílá upstream
- podporuje běžné `claude auth login --claudeai` i setup token předaný přes `CLAUDE_CODE_OAUTH_TOKEN`
- token ukládá atomicky s právy `0600` do `~/.pi/agent/cache/claude-code-subscription-provider.json` (respektuje `PI_CODING_AGENT_DIR`)
- při neplatném cached tokenu udělá jeden refresh před viditelnou odpovědí; podporuje i `403 oauth_not_allowed_for_organization`
- auth status i capture mají timeout a podporují cancellation; souběžní čekající sdílejí refresh
- respektuje `maxTokens`, `cacheRetention: "none"` i system instructions; session ID a billing prefix zůstávají stabilní v rámci session
- nativní `/compact` i `/tree` se summary používají stejný provider; auxiliary request bez reasoning zůstává validní i na always-on-thinking modelech
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
/model claude-code-subscription-provider/opus-5-5
/model claude-code-subscription-provider/opus-5
/model claude-code-subscription-provider/opus-4-8
/model claude-code-subscription-provider/opus-4-7
/model claude-code-subscription-provider/opus-4-6
/model claude-code-subscription-provider/sonnet-4-6   # 256k context
/model claude-code-subscription-provider/fable-5-1
/model claude-code-subscription-provider/fable-5
```

Volitelně lze zkontrolovat nebo refreshnout cache:

```text
/claude-code-auth
/claude-code-auth refresh
/claude-code-auth clear
```

## Testy

```bash
npm run check
npm test
```

Testy nepoužívají skutečné credentials ani Anthropic API. Zahrnují nativní
`AgentSession.compact()` a `navigateTree(..., { summarize: true })`, streaming,
tool/thinking replay, token refresh, cancellation a lokální TLS capture.

`npm audit --omit=dev` zatím hlásí tři transitive findings v `http-mitm-proxy`
(`node-forge` a `uuid`), bez dostupného kompatibilního fixu. Proxy používá UUID v4,
nepostižené v3/v5/v6, a TLS ověřuje Node, ne RSA verifier z `node-forge`.
Proxy binduj jen na loopback; její CA nesdílej.

Použití subscription OAuth mimo oficiální Claude Code nemusí být podporované
Anthropicem; viz [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).
API katalog sám o sobě nepotvrzuje dostupnost modelu na subscription.

## Příklady

Spustit jen proxy:

```bash
node src/claude-network-interceptor.js
```

Spustit přímo Claude přes proxy:

```bash
node src/claude-network-interceptor.js --exec claude -- --print "Hello world"
```
