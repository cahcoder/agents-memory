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

Both user AND AI go to the **same collection** based on user message content.

### Complete Collection Reference

#### laws
**When:** User explicitly says "make this a rule/guideline/workflow"

User is instructing AI to always follow a certain behavior. This is the HIGHEST priority collection because it's an explicit directive.

**Keywords:** `make this a rule`, `make this a guideline`, `make this a workflow`, `always do`, `never do`, `this is a rule`, `must do`, `should always`

**Example:** "Make this your workflow: when I ask to fix a bug, first check logs, then check recent changes"

---

#### tasks
**When:** User asks how to do something or has a problem to solve

This is for learning and knowledge capture - how to solve specific problems, step-by-step processes, explanations.

**Keywords:** `how to`, `how do`, `what is`, `what are`, `why does`, `why did`, `explain`, `help me`, `i need to`, `i want to`, `fix`, `debug`, `can you`, `could you`, `would you`, `please`, `implement`, `create`, `build`, `make`, `develop`, `setup`, `configure`

**Example:** "how do I fix the memory leak in the daemon?"

---

#### progress
**When:** Task completed or milestone reached

Captures what was accomplished. Use for tracking completed work, finished tasks, bugs fixed, features implemented.

**Keywords:** `done`, `finished`, `completed`, `fixed`, `solved`, `working now`, `its working`, `just finished`, `already done`, `success`, `updated`, `changed`, `modified`, `improved`

**Example:** "Fixed the collection mapping bug - tasks now go to tasks collection instead of casual"

---

#### plan
**When:** Future intentions, roadmap, or next steps

Captures what will be done, intended actions, or planned work. Use for tracking future goals.

**Keywords:** `will`, `going to`, `plan to`, `intend to`, `next step`, `next phase`, `roadmap`, `should do`, `need to`, `must do`, `will do`, `tomorrow`, `later`, `eventually`

**Example:** "Next I'll add MCP tool support, then test the memory save flow"

---

#### important
**When:** Key facts, preferences, or things to remember

Captures user preferences, important facts, configuration details, or critical information.

**Keywords:** `remember`, `important`, `preference`, `don't forget`, `note that`, `keep in mind`, `my name`, `my preference`, `my setting`, `my config`

**Example:** "Remember that I prefer Indonesian language for casual conversation"

---

#### core
**When:** Baseline knowledge, architecture, or foundational decisions

Captures project architecture, tech stack decisions, or knowledge that forms the foundation of how things work. Rarely changes.

**Keywords:** `architecture`, `project structure`, `tech stack`, `baseline`, `core decision`, `this is how we`, `this is the way we`

**Example:** "The project uses Python daemon with Chroma DB for semantic memory storage"

---

#### casual
**When:** Casual conversation, greetings, or small talk

For informal exchanges that don't contain learning or decisions.

**Keywords:** `hi`, `hey`, `hello`, `thanks`, `thank you`, `ok`, `okay`, `yes`, `no`, `good`, `nice`, `yeah`, `sure`, `fine`, `cool`

**Example:** "Hi!" or "Thanks for the help"

---

#### prompts
**When:** Default collection for questions that don't match above

Catch-all for any question or statement that doesn't fit other categories. Most user messages end up here initially.

**Keywords:** (none - this is the default)

**Example:** "What's the weather?" or "Tell me about X"

---

#### working
**When:** AI responses in a paired conversation

This collection stores the AI's response paired with the user's question. It's used for context when resuming conversations.

**Note:** This is automatically paired with whatever collection the user message used. So if user asks "how to fix X", both go to tasks, not working.

---

### Quick Reference Table

| Collection | Priority | When | Example |
|------------|----------|------|---------|
| laws | 1 (highest) | Explicit rule | "Make this a rule: always check logs first" |
| tasks | 2 | Questions/how-to | "how to fix the bug?" |
| progress | 3 | Completed work | "Fixed the memory leak" |
| plan | 4 | Future intentions | "Next I'll add MCP support" |
| important | 5 | Preferences/facts | "Remember I prefer dark mode" |
| core | 6 | Architecture | "We use Python + Chroma DB" |
| casual | 7 | Small talk | "Thanks!" |
| prompts | 8 (default) | Questions | "What's for lunch?" |
| working | N/A | AI responses | (auto-paired with user) |

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
