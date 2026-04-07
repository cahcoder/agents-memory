# agents-memory

> **Grows Longer It Runs — Persistent memory and auto-generated skills**
>
> It learns your projects and never forgets how it solved a problem.

---

## What is agents-memory?

agents-memory is a universal semantic memory layer for AI CLI tools (OpenClaw, Codex, Cursor, etc.). It:

- **Remembers everything** — every problem and solution is stored in ChromaDB
- **Routes intelligently** — automatic classification into 10 collections based on content
- **Injects context** — AI sees relevant past work before responding
- **Auto-saves** — no manual save required after every message
- **Scales forever** — grows smarter with every conversation

---

## Quick Start

```bash
# Install from npm
npm install -g agents-memory

# Initialize (one-time setup — installs daemon, hook, MCP, systemd service)
agents-memory init

# Restart OpenClaw gateway to load hook
openclaw gateway restart

# Done. Everything works automatically.
```

**No manual steps required.** The `init` command handles everything:

1. ✅ Starts daemon via systemd user service
2. ✅ Installs hook → `~/.openclaw/hooks/agents-memory/handler.js`
3. ✅ Installs MCP → `~/.openclaw/mcp/memory-save.cjs`
4. ✅ Registers MCP in `~/.openclaw/openclaw.json`
5. ✅ Configures OpenClaw to use memory

---

## Pipeline (How It Works)

### Message Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     User sends message                         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│           PRE-LLM HOOK (message:preprocessed)               │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 1. Clean up STALE pending (>2 min without response)    │   │
│  │ 2. Set current message as PENDING                      │   │
│  │ 3. Inject LAWS (unconditional — always present)         │   │
│  │ 4. Search 5 collections: working, tasks, progress,     │   │
│  │    core, important (semantic search with relevance score)│   │
│  │ 5. Inject top results (max 5000 chars)                │   │
│  │ 6. Inject auto-save instruction (MCP tool call)        │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                     AI generates response                      │
│         (sees laws + context + auto-save instruction)         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│           AI calls memory_save MCP tool                        │
│      (memory-save__memory_save(problem, solution, collection))  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│           POST-LLM HOOK (message:sent)                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 1. Pair AI response with pending user message         │   │
│  │ 2. Classify collection (determineCollection())         │   │
│  │ 3. Save to daemon via socket                          │   │
│  │ 4. Mark pending as saved                              │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    DAEMON (background)                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 1. Route to correct collection (type→collection map)    │   │
│  │ 2. Generate embedding (cached for repeated queries)     │   │
│  │ 3. Store in ChromaDB with metadata                   │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Collections (What Goes Where)

### Unified Routing (`shared/collections.json`)

| Collection | Type From Hook | What It Stores | Examples |
|------------|----------------|----------------|----------|
| **laws** | `law` | Hard rules, guidelines, workflows | "Always restart daemon after config change" |
| **tasks** | `solution`, `skill` | Problem → solution pairs | "How to fix nginx 502: restart php-fpm" |
| **progress** | `summary`, `progress` | Completed work milestones | "Deployed v1.2.4 to production" |
| **plan** | `decision` | Goals, roadmaps, future work | "Will implement OAuth2 next sprint" |
| **core** | `baseline` | Architecture decisions, tech stack | "Use PostgreSQL for all new projects" |
| **important** | `fact` | Important facts, preferences | "User prefers Indonesian language" |
| **casual** | `chat` | Conversational chatter | "Thanks for the help!" |
| **prompts** | `prompt` | User message history | "How do I restart the daemon?" |
| **working** | `working`, `msg` | AI responses (temporary) | "Starting deployment now..." |
| **critical** | `critical` | Time-sensitive alerts | "Database backup failed at 3AM" |

### Auto-Collection Detection

The hook automatically detects which collection to use based on content:

```javascript
// Laws (highest priority)
/this is a (rule|guideline|law)/i
/always (do|must)/i
/never (do|must)/i

// Progress
/done|completed|fixed|solved/i
/just did|already working/i

// Plan
/will|going to|plan to/i
/next step|roadmap/i

// Important Facts
/remember|important|don't forget/i
/my (name|preference)/i

// Core (Architecture)
/architecture|tech stack|project structure/i
/baseline|core decision/i

// Default: casual
```

---

## Context Injection (What AI Sees)

### 3-Layer Injection

**Layer 1: LAWS (unconditional)**
```system
LAWS (always follow):
---
Always restart daemon after config change
Rule confirmed: Always test after changes
Never delete files without asking first
```

**Layer 2: Semantic Context (relevance-scored)**
```system
Relevant context:
---
[tasks] score=0.947
Problem: nginx 502 error
Solution: restart php-fpm and clear cache
---
[progress] score=0.931
Problem: deploy v1.2.4
Solution: Done. All services running
---
[core] score=0.902
Problem: architecture decision
Solution: Use PostgreSQL for all new projects
```

**Layer 3: Auto-Save Instruction**
```system
[MEM] After responding, call memory-save__memory_save(
  problem="<summary 200chars>",
  solution="<response 500chars>",
  collection="tasks"
). Required.
```

### Configuration

| Setting | Value | Description |
|---------|-------|-------------|
| `MAX_INJECT_CHARS` | 5000 | Max context chars per message |
| `COMPACTION_THRESHOLD` | 5 messages | When to compact working collection |
| `semanticCollections` | 5 collections | working, tasks, progress, core, important |

---

## Compaction (Auto-Cleanup)

After every 5 messages, the system automatically:

1. Retrieves all messages from `working` collection for current session
2. Asks AI to summarize them (via system prompt injection)
3. Deletes old entries from `working`
4. Saves summary to `progress` collection
5. Resets message counter

This prevents context bloat while preserving key learnings.

---

## Daemon (Background Service)

### What It Does

- Runs as systemd user service (`~/.config/systemd/user/agents-memory.service`)
- Listens on Unix socket (`~/.memory/agents-memory/daemon.sock`)
- Keeps embedding model loaded in memory (sentence-transformers/all-MiniLM-L6-v2)
- Handles concurrent clients with threading
- Caches embeddings for repeated queries (LRU, max 500 entries)

### Commands

```bash
# Start daemon
agents-memory start

# Stop daemon
agents-memory stop

# Restart daemon
agents-memory restart

# Check status
agents-memory status

# View stats
agents-memory stats
```

### Caching

| Cache Type | Max Entries | TTL | Purpose |
|------------|-------------|-----|---------|
| Embedding | 500 | None | Reuse query embeddings across collections |
| Query | 100 | 5 min | Cache search results for repeated queries |

---

## MCP Tools (What AI Can Call)

### memory_save

```javascript
memory-save__memory_save({
  problem: "Summary of what user asked (max 200 chars)",
  solution: "AI response summary (max 500 chars)",
  collection: "tasks"  // optional, auto-detected if omitted
})
```

### memory_search

```javascript
memory-search__memory_search({
  query: "nginx 502 error",
  limit: 3,           // optional, default 5
  collection: "tasks"  // optional, searches all if omitted
})
```

---

## CLI Commands

```bash
# Save a memory manually
agents-memory write "problem description" -s "solution" -t tasks

# Search memory
agents-memory search "nginx 502 error"

# Search specific collection
agents-memory search "architecture" --collection core

# View stats
agents-memory stats

# Garbage collection (delete stale entries)
agents-memory gc

# Initialize fresh installation
agents-memory init

# Uninstall completely
agents-memory uninstall
```

---

## Directory Structure

```
agents-memory/
├── scripts/
│   ├── memory_daemon.py    # Unix socket daemon
│   ├── chroma_client.py    # ChromaDB client + search
│   └── install-seamless.cjs # One-shot installer
├── hooks/
│   └── agents-memory/
│       └── handler.js      # PRE-LLM + POST-LLM hooks
├── hook-packs/
│   └── agents-memory/
│       └── handler.js      # Synced copy for npm distribution
├── mcp/
│   └── memory-save.cjs     # MCP server (@modelcontextprotocol/sdk)
├── shared/
│   └── collections.json    # Unified routing map
├── src/
│   └── cli.js             # CLI commands
└── config/
    └── settings.json      # ChromaDB + cache config
```

---

## Configuration

### Daemon Config (`config/settings.json`)

```json
{
  "chroma_path": "~/.memory/chroma",
  "persist_directory": "~/.memory/chroma",
  "embedding_model": "sentence-transformers/all-MiniLM-L6-v2",
  "EMBEDDING_CACHE_MAX": 500,
  "QUERY_CACHE_MAX": 100,
  "QUERY_CACHE_TTL": 300
}
```

### Hook Config (in code)

```javascript
const MAX_INJECT_CHARS = 5000;
const COMPACTION_THRESHOLD = 5;
const CACHE_TTL = 300000;  // 5 minutes
const CACHE_MAX = 100;
```

---

## Troubleshooting

### Daemon not responding

```bash
# Check if daemon is running
ps aux | grep memory_daemon

# Restart
agents-memory restart

# Check socket
ls -la ~/.memory/agents-memory/daemon.sock
```

### Hook not injecting context

```bash
# Check hook installed
ls ~/.openclaw/hooks/agents-memory/handler.js

# Restart OpenClaw gateway
openclaw gateway restart

# Check OpenClaw log
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep agents-memory
```

### MCP tools not available

```bash
# Check MCP file exists
ls ~/.openclaw/mcp/memory-save.cjs

# Check openclaw.json
cat ~/.openclaw/openclaw.json | grep -A5 "memory-save"

# Reload OpenClaw config
openclaw gateway reload
```

### Search returns no results

```bash
# Check collection counts
agents-memory stats

# Write test entry
agents-memory write "test problem" -s "test solution" -t working

# Search again
agents-memory search "test problem"
```

---

## Data Persistence

### Where Data Is Stored

```
~/.memory/
├── chroma/
│   └── chroma.sqlite3      # All embeddings (vector DB)
└── agents-memory/
    ├── daemon.sock         # Unix socket
    ├── daemon.pid          # Process ID
    └── pending.json       # Unpaired user messages
```

### Data Never Deleted (Unless Manually)

- **Laws**, **core**, **progress**: Never auto-deleted
- **tasks**: Deleted when marked as `done`
- **working**: Auto-compacted after 5 messages (summarized to progress)
- **casual**, **prompts**: 30-day TTL (garbage collection)

---

## Development

### Run from source

```bash
cd /srv/apps/agents-memory

# Install Python deps
pip install -r requirements.txt

# Run daemon in foreground
python3 scripts/memory_daemon.py

# Run hook (via OpenClaw)
openclaw gateway reload
```

### Build npm package

```bash
npm pack
# Creates: agents-memory-1.1.4.tgz
```

### Publish to npm

```bash
npm publish
```

---

## License

MIT

---

## Credits

Built for OpenClaw — The persistent memory layer that grows smarter with every conversation.

**Goal**: "Grows Longer It Runs — Persistent memory and auto-generated skills — it learns your projects and never forgets how it solved a problem."
