# agents-memory

> **Universal semantic memory layer for AI CLI tools. Remembers everything, forgets nothing.**

Semantic memory system that grows smarter over time. Prevents context overflow and AI "gibberish" through semantic vector search.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---


## Case Study: AI Forgetting Context

**Scenario:** AI processes a task in session A, then in session B doesn't remember decisions made.

```
Session A:
AI: "/srv is a restricted folder — I cannot access it"
    ↓
[Session ends, context lost]
    ↓
Session B:
User: "what were we working on?"
AI: [no memory of session A]
```

**With agents-memory:**

```
Session A:
AI: "/srv is a restricted folder"
    ↓
Post-LLM stores to memory
    ↓
[Session ends]
    ↓
Session B:
User: "what were we working on?"
    ↓
Pre-LLM searches memory
    ↓
→ Finds session A context
    ↓
INJECT: AI sees previous decisions
    ↓
AI: "In session A, we confirmed /srv is restricted..."
```

The `laws` collection ensures **critical rules are NEVER forgotten** — they're always injected, even for unrelated prompts.

## The Problem

AI CLI tools share a fatal flaw: **they forget everything between sessions**.

- Context window fills up → AI starts "gibberish"
- Same problems solved repeatedly → no learning
- Decisions made in session A are lost in session B
- Project context disappears when chat history grows too large

## The Solution

```
┌─────────────────────────────────────────────────────────────┐
│  PRE-LLM                  POST-LLM                          │
│     ↓                        ↓                              │
│  Query memory ──────────→  Store learning                  │
│     ↓                        ↓                              │
│  Inject context ────────→  Update patterns                │
│                                                             │
│         Continuous Learning Loop                            │
└─────────────────────────────────────────────────────────────┘
```

**Pre-LLM**: Before AI processes a task → query relevant memory → inject context  
**Post-LLM**: After AI responds → analyze for new learnings → store to vector DB

## Features

| Feature | Description |
|---------|-------------|
| **Semantic Search** | HNSW/ANN vector search — finds context in 300K+ entries at O(log n) |
| **Query Expansion** | Expands queries with synonyms for better recall (restart → restart, reboot, reload...) |
| **Collection Priority** | Results weighted by collection importance (critical > core > plan > spec) |
| **Retrieval Feedback** | Frequently retrieved entries get score boost (implicit positive signal) |
| **LRU Cache** | Caches search results (200 entries, 5 min TTL) |
| **Query Optimization** | Stopword removal + smart snippet extraction |
| **Write Quality Control** | Quality checks, dedup, min length on stored entries |
| **Domain Collections** | Separate critical, core, plan, spec, important, tasks, casual, prompts, progress |
| **Garbage Collection** | Auto dedup, decay, trash old entries |

## Tech Stack

```
Language     │ Python 3.x + Node.js CLI
Embedding   │ sentence-transformers / all-MiniLM-L6-v2 (384 dims)
Vector DB   │ Chroma (embedded DuckDB, no daemon)
ANN Search  │ HNSW (ef_search=200, m=48)
Similarity  │ Cosine similarity
```

## Installation (Single-Shot)

```bash
# From local tgz (recommended for testing)
npm install -g /path/to/agents-memory-1.1.1.tgz

# From npm (when published)
npm install -g agents-memory

# That's it! Postinstall handles:
# ✅ Python dependencies
# ✅ Daemon service (systemd)
# ✅ OpenClaw hook installation
# ✅ OpenClaw config auto-update
# ✅ Gateway reload
```

### What Gets Installed

| Component | Location |
|-----------|----------|
| CLI | `~/.npm-global/bin/agents-memory` |
| Python scripts | `~/.npm-global/lib/node_modules/agents-memory/scripts/` |
| Hook handler | `~/.openclaw/hooks/agents-memory/` |
| Memory data | `~/.memory/chroma/` |
| Daemon | `~/.memory/agents-memory/daemon.sock` |
| Service | `systemd --user agents-memory-daemon.service` |

---

## Commands

| Command | Description |
|---------|-------------|
| `agents-memory --version` | Check version |
| `agents-memory search <query>` | Search memory |
| `agents-memory write <problem> [solution]` | Store learning |
| `agents-memory batch-write --json '[...]'` | Store multiple learnings |
| `agents-memory set-project <name>` | Set project context |
| `agents-memory bootstrap <project>` | Init project memory |
| `agents-memory gc [--stats]` | Run garbage collection |
| `agents-memory uninstall` | Complete uninstall |

---

## Quick Start

```bash
# Search memory
agents-memory search "postgres restart"

# Store a learning
agents-memory write "container postgres crash" "docker restart {container_name}"

# Bootstrap new project
agents-memory bootstrap myproject --architecture "FastAPI + PostgreSQL"

# Run GC
agents-memory gc --stats
```

---

## How It Works

### 1. Pre-LLM Hook

```
User: "restart postgres container"
    ↓
Hook fires: message:preprocessed
    ↓
agents-memory searches Chroma
    ↓
→ Finds: "docker restart {container_name}"
    ↓
INJECT: Relevant context injected into AI prompt
    ↓
AI processes WITH context
```

### 2. Post-LLM Hook

```
AI responds successfully
    ↓
Session compaction occurs
    ↓
Hook fires: session:compact:after
    ↓
Stores new learnings to Chroma
    ↓
Updates use_count, importance
```

### 3. Retrieval Feedback Loop

```
Entry retrieved in search
    ↓
retrieval_count++
last_retrieved updated
    ↓
Frequent retrieval = useful = score boost in future
```

Score boost formula: `retrieval_boost = min(0.10, 0.01 * log1p(retrieval_count))`

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  OpenClaw Gateway                                          │
│                                                             │
│  ~/.openclaw/hooks/agents-memory/handler.js ← Managed hook │
└─────────────────────────────────────────────────────────────┘
                              ↓ socket
┌─────────────────────────────────────────────────────────────┐
│  agents-memory-daemon (systemd service)                    │
│                                                             │
│  memory_daemon.py ← UNIX socket server                     │
│  chroma_client.py ← ChromaDB client                        │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  Chroma Vector DB (~/.memory/chroma/)                      │
│                                                             │
│  collections: critical, core, plan, spec, important,       │
│              tasks, casual, prompts, progress              │
└─────────────────────────────────────────────────────────────┘
```

---


## Laws Collection — Unconditional Rules

The `laws` collection stores **hard rules that AI must ALWAYS follow**, regardless of prompt content.

| Feature | Behavior |
|---------|----------|
| **Injection** | ALWAYS injected on every message (no keyword matching) |
| **Use case** | Critical constraints: "/srv forbidden", "never delete without asking", etc. |
| **TTL** | Never auto-deleted |
| **Example** | `/srv is a restricted folder — never access` |

### How It Works

```
User: "hello"  ← unrelated prompt
    ↓
Hook queries laws collection with dummy query
    ↓
→ Finds: "/srv is forbidden" rule
    ↓
INJECT: Laws + keyword results combined
    ↓
AI sees: laws first, then relevant context
```

### Adding Laws

```bash
python3 ~/.npm-global/lib/node_modules/agents-memory/scripts/memory_daemon.py << 'PYEOF'
import socket, json
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect('/home/developer/.memory/agents-memory/daemon.sock')
sock.sendall(json.dumps({
    'cmd': 'write',
    'args': {
        'problem': 'Your law here',
        'solution': 'What AI should do',
        'type': 'law'
    }
}).encode())
print(sock.recv(1024).decode())
sock.close()
PYEOF
```

### Querying Laws

```bash
# Get all laws (no limit)
LAWS_LIMIT=0 agents-memory search "any query"

# Or via socket directly
python3 ~/.npm-global/lib/node_modules/agents-memory/scripts/memory_daemon.py << 'PYEOF'
import socket, json
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect('/home/developer/.memory/agents-memory/daemon.sock')
sock.sendall(json.dumps({
    'cmd': 'search',
    'args': {'query': 'LAWS', 'collection': 'laws', 'limit': 50}
}).encode())
resp = sock.recv(65536)
data = json.loads(resp.decode())
for r in data['data']['data']:
    print(r['content'])
sock.close()
PYEOF
```

---

## Collections

| Collection | TTL | Purpose |
|------------|-----|---------|
| **laws** | **never** | **Hard rules — ALWAYS injected on every message** |
| critical | never | Critical, time-sensitive alerts |
| core | 5 years | Core facts, design decisions |
| plan | never | Project plans, roadmaps |
| spec | never | Project specifications |
| important | 2 years | Important but not critical |
| tasks | on-complete | Solutions, skills, todos |
| casual | 30 days | Chat, preferences |
| prompts | 90 days | User prompts history |
| progress | never | Resume tracker |

---

## Entry Schema

```json
{
  "id": "uuid-v4",
  "project": "project_name",
  "entry_type": "solution | skill | fact | decision | baseline | chat | law",
  "problem": "What problem does this solve?",
  "solution": "Generic template or answer",
  "language": "python | bash | sql | yaml | ...",
  "use_count": 0,
  "last_used": "ISO timestamp",
  "importance": 0.0-1.0,
  "timestamp": "ISO timestamp"
}
```

---

## Configuration

Config file: `~/.openclaw/openclaw.json`

The hook is automatically added during install:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "agents-memory": { "enabled": true }
      }
    }
  }
}
```

### Advanced Settings

```yaml
# config/settings.yaml
chroma:
  persist_directory: "~/.memory/chroma"
  embedding_model: "all-MiniLM-L6-v2"
  dimensions: 384

collections:
  default_importance: 0.5
  priority:
    critical: 0.30
    core: 0.25
    plan: 0.22
    spec: 0.20
    important: 0.15
    progress: 0.12
    tasks: 0.10
    prompts: 0.05
    casual: 0.00

memory:
  search:
    max_query_length: 200
    cache_ttl_seconds: 30
    cache_max_entries: 100
    hnsw:
      ef_search: 200
      ef_construction: 200
      m: 48

gc:
  dedup_interval_days: 7
  archive_after_days: 90
  trash_retention_days: 30
```

---

## Verify Installation

Check that the hook is loaded:

```bash
openclaw hooks list
```

Should show `agents-memory` with events: `message:preprocessed`, `session:compact:after`

### Check Logs

```bash
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep agents-memory
```

---

## Cleanup / Reset

### Fresh reinstall (keep config, reset memory):

```bash
# Via CLI
agents-memory uninstall

# Or manual:
# 1. systemctl --user stop agents-memory-daemon
# 2. rm -rf ~/.memory/chroma/
# 3. npm install -g /path/to/agents-memory-1.1.1.tgz
```

### Complete removal (everything):

```bash
# 1. systemctl --user stop agents-memory-daemon memory-gc.timer memory-trash.timer
# 2. systemctl --user disable agents-memory-daemon memory-gc.timer memory-trash.timer
# 3. rm -rf ~/.memory/chroma/ ~/.memory/agents-memory/
# 4. rm -rf ~/.openclaw/hooks/agents-memory/
# 5. Edit ~/.openclaw/openclaw.json — remove hooks.internal.entries.agents-memory
# 6. npm rm -g agents-memory
```

---

## License

MIT License — See [LICENSE](LICENSE)

---

*"Grows the Longer It Runs"*

---

## Working Collection — Active Conversations

The `working` collection stores **message pairs** (user + AI) to track active conversations, with topic-based summarization on compaction.

| Field | Description |
|-------|-------------|
| `topic_id` | Session ID or auto-generated topic ID |
| `messages` | Array of conversation turns |
| `summary` | AI-generated summary (post-compaction) |
| `msg_count` | Number of messages in this topic |
| `last_updated` | Timestamp of last update |

### Flow

```
Phase 1: Continuous Insert (per message)
User: "ok proceed" → AI response
    ↓ Insert to working[topic_id] (msg_count + 1)
User: "then test" → AI response
    ↓ Insert to working[topic_id] (msg_count + 2)
...

Phase 2: Compaction (when threshold reached)
working[topic_id] has 5 entries
    ↓ Trigger: "Should I compact?"
    ↓ AI generates summary
    ↓ DELETE 5 entries
    ↓ INSERT 1 summarized entry
    ↓ msg_count resets to 0

Phase 3: Resume (new session with same topic)
User: "continue production fix"
    ↓ Search working collection
    ↓ Find summarized entry
    ↓ Inject: "Previous: production daemon fix discussion"
    ↓ AI continues from checkpoint
```

### Adding Entries (Automatic)

Every user message + AI response is automatically stored in `working` collection. No manual action needed.

### Compaction (AI-Driven)

When `msg_count` reaches threshold (default: 5), the hook injects an explicit task to consolidate memory.

**Injected message:**
```
[memory: 5 messages logged in 'working' collection for session {session_id}. Threshold: 5. Consider requesting memory consolidation.]
```

**AI generates summary** (natural language response):
```
Based on the following conversation messages, provide a concise summary:

{Topic} - Progress
- What we've done: [bullet points]
- What's next: [bullet points]

Format: "{Topic} - Progress" followed by bullet points.
```

**Hook detects "MEMORY CONSOLIDATED"** in AI response → compaction executes:
1. Retrieve all messages from `working` collection for session_id
2. Delete old entries
3. Insert new summarized entry
4. Reset `msg_count` to 0

### Usage

```bash
# View working entries
memory init <topic_id>

# Trigger compaction manually
# AI will see threshold message and summarize automatically

# Search working with session filter
memory search "your query" --project "topic_id"
```

---


---

## Auto-Save Every Message (2026-04-06)

**IMPORTANT:** Every AI response is automatically saved to the `working` collection.

### How It Works

```
User: "ok proceed with production fix"
    ↓
PRE-LLM hook injects save prompt
    ↓
AI generates response
    ↓
AI writes to 'working' collection
    ↓
AI replies with "[memory saved]"
    ↓
Hook detects save → skips backup storage
```

### PRE-LLM Injection (Every Message)

```javascript
// Every message:preprocessed injects this:
event.messages.push({
    role: "system",
    content: `[memory] IMPORTANT: Save every response to agents-memory.
Your response will be stored in the 'working' collection (session_id: {sessionId}).

TASK:
1. After providing your response, call memory write:
   - cmd: write
   - type: working  
   - problem: Brief summary of what was discussed (max 200 chars)
   - solution: Key outcome or decision made
   - metadata: {session_id: "{sessionId}"}

2. Reply with "[memory saved]" at the end of your response to confirm.

This applies to EVERY message. AI must save every response.`
});
```

### AI Behavior

1. **Receives save prompt** with every message
2. **Calls memory write** to store in `working` collection
3. **Confirms** with "[memory saved]" at end of response
4. **Hook detects** confirmation → skips duplicate backup storage

### Save Confirmation Patterns

AI will respond with one of these to confirm save:
- `[memory saved]`
- `memory consolidated`
- `saved to memory`
- `stored in working`
- `progress updated`

If AI doesn't include save confirmation, `sessionCompactAfter` acts as backup storage.

### Collection Selection

| Collection | When Used | AI Action |
|------------|-----------|-----------|
| `working` | **Every message** | AI writes user msg + AI response |
| `progress` | After compaction (5+ messages) | AI summarizes → deletes working → inserts to progress |
| `laws` | **Always** on every message | Injected (not AI-written) |
| `critical` | Alert situations | Manual write: `type=critical` |
| `core` | Core facts/decisions | Manual write: `type=baseline` |

### Gateway Restart

**Yes, gateway restart is needed** to load updated handler.js:

```bash
nohup openclaw gateway restart > /dev/null 2>&1 &
```

Or use:
```bash
systemctl --user restart openclaw-gateway.service
```

---

## Auto-Save with AI Response Pairing (2026-04-06)

**Problem:** Original auto-save only saved user messages. AI responses were lost.

**Solution:** Message pairing + stale cleanup via systemd timer.

### Flow

```
User sends Message A
       ↓
Hook fires (message:preprocessed)
       ↓
1. pending[A] = {msg: "Message A", saved: false}
       ↓
AI generates response
       ↓
User sends Message B
       ↓
Hook fires
       ↓
2. Check pending[A] → saved: false
       ↓
3. Read AI response for Message A from session file
       ↓
4. Save: pending[A].msg + AI response → working collection
       ↓
5. pending[A].saved = true, DELETE
       ↓
6. pending[B] = {msg: "Message B", saved: false}
```

### Stale Cleanup (Systemd Timer)

If user goes inactive after Message A, pending[A] never gets paired.

**Solution:** Systemd timer runs every 1 minute:

```
Timer fires (every 1 minute)
       ↓
Read pending.json
       ↓
Check pending entries > 2 minutes old
       ↓
For each stale pending:
  - Read last AI response from session file
  - Save to working collection
  - Mark pending.saved = true
```

**Files:**
- Timer: `~/.config/systemd/user/agents-memory-stale-cleanup.timer`
- Service: `~/.config/systemd/user/agents-memory-stale-cleanup.service`
- Script: `~/.openclaw/scripts/cleanup-stale-pending.sh`
- Pending: `~/.memory/agents-memory/pending.json`

### Race Condition Protection

**Problem:** Timer and hook could both try to save same pending.

**Solution:** `saved` flag prevents duplicate saves:

```javascript
// Before saving
if (pending.saved) {
    continue;  // Skip already saved
}

// After saving
pending.saved = true;
pendingUserMessages.delete(key);
savePendingToFile();  // Persist to disk
```

### OpenClaw Event Structure

The hook reads from `event.context.bodyForAgent` (NOT `event.messages`):

```javascript
event.messages = []  // EMPTY - dont use
event.context.bodyForAgent = "[Mon 2026-04-06 21:48 GMT+7] message"  // USE THIS
event.context.body = "message"  // raw without prefix
event.context.sessionKey = "agent:main:main"
```

---

## Summary of Latest Changes (2026-04-06)

| Feature | Status | Description |
|---------|--------|-------------|
| Message pairing | ✅ | User + AI response saved together |
| Stale cleanup | ✅ | Systemd timer cleans up inactive sessions |
| Race protection | ✅ | `saved` flag prevents duplicates |
| Event structure | ✅ | Uses `event.context.bodyForAgent` |
| Pending persistence | ✅ | Saved to `pending.json` for timer access |

