# agents-memory

> Universal semantic memory layer for AI CLI tools. Remembers everything, forgets nothing.

## Quick Start

```bash
# Install
npm install -g agents-memory

# Start daemon
memory_daemon.py &

# Save a memory
agents-memory write "what user asked" -s "what AI answered" -t tasks

# Search
agents-memory search "query"
```

## Architecture

```
User Message → Hook → Pending → Next Message → Paired Save → Collection
                                    ↓
                             AI Response
                                    ↓
                             Same Collection
```

## Collections

Both user AND AI go to the **same collection** based on user message:

| Collection | When | Keywords |
|------------|------|----------|
| **laws** | User says "make this a rule" | rule, guideline, workflow, always, never |
| **tasks** | Questions/how-to | how, what, why, explain, fix, debug, help |
| **progress** | Completed work | done, finished, completed, fixed, solved |
| **plan** | Future intentions | will, going to, next step, roadmap |
| **important** | Key facts/preferences | remember, important, preference |
| **core** | Architecture/baseline | architecture, tech stack, decisions |
| **casual** | Small talk | hi, thanks, ok, hello |
| **prompts** | Default questions | anything else |
| **working** | AI responses | paired with user message |

## Type Mapping

Hook collections map to daemon types:

| Hook | Daemon Type | Collection |
|------|-------------|------------|
| `laws` | `law` | laws |
| `tasks` | `solution` | tasks |
| `progress` | `summary` | progress |
| `plan` | `decision` | progress |
| `important` | `fact` | important |
| `core` | `baseline` | core |
| `casual` | `chat` | casual |
| `prompts` | `prompt` | prompts |
| `working` | `working` | working |

## Hook Installation

```bash
# Copy handler to OpenClaw hooks
cp hook-packs/agents-memory/handler.js ~/.openclaw/hooks/agents-memory/

# Restart gateway
nohup openclaw gateway restart &
```

## Daemon

```bash
# Start manually
python3 scripts/memory_daemon.py &

# Or use systemd
systemctl --user enable agents-memory-daemon.service
systemctl --user start agents-memory-daemon.service
```

## Files

- `scripts/memory_daemon.py` - Persistent daemon
- `scripts/memory_write.py` - CLI write tool
- `scripts/memory_search.py` - CLI search tool
- `hook-packs/agents-memory/handler.js` - OpenClaw hook
- `hook-packs/agents-memory/HOOK.md` - Hook documentation

## Commands

```bash
# Write
agents-memory write "problem" -s "solution" -t tasks

# Search
agents-memory search "query" -c tasks -l 5

# Stats
agents-memory stats
```

## Environment

```bash
export HOME=/home/user
export MEMORY_DIR=~/.memory/agents-memory
export DAEMON_SOCK=$MEMORY_DIR/daemon.sock
```
