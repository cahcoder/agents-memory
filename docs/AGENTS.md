# Universal Semantic Memory

Works with: Claude Code, Gemini CLI, OpenCode, Cursor, Codex, any AI CLI via AGENTS.md.

---

## Quick Start

```bash
# Clone anywhere
git clone git@github.com:cahcoder/agents-memory.git ~/agents-memory

# Add to shell profile (pick one)
echo 'export MEMORY_DIR="$HOME/.memory/chroma"' >> ~/.bashrc
echo 'export SKILL_DIR="$HOME/agents-memory/skill"' >> ~/.bashrc

# Reload
source ~/.bashrc
```

---

## Memory Pipeline

```
Task → PRE-LLM: search relevant context → Inject → AI → POST-LLM: store learnings → Response
```

### PRE-LLM (Before AI thinks)
```bash
python3 $SKILL_DIR/memory_search.py "<task>" --project <name> --limit 5
```

### POST-LLM (After AI responds)
```bash
python3 $SKILL_DIR/memory_write.py "<problem>" --solution "<solution>" --type solution --project <name>
```

---

## Essential Commands

```bash
# Search memory
python3 $SKILL_DIR/memory_search.py "<query>"

# Store learning
python3 $SKILL_DIR/memory_write.py "<problem>" --solution "<solution>"

# Bootstrap new project
python3 $SKILL_DIR/memory_bootstrap.py <project_name> --architecture "<description>"

# Stats & cleanup
python3 $SKILL_DIR/memory_gc.py --stats

# Intelligence
python3 $SKILL_DIR/scripts/intelligence.py patterns
python3 $SKILL_DIR/scripts/intelligence.py velocity
```

---

## Entry Types

| Type | Use For |
|------|---------|
| `solution` | Problem → solution pairs |
| `skill` | Reusable techniques |
| `fact` | Factual knowledge |
| `decision` | Architecture choices |
| `learning` | Post-LLM conversation learnings |
| `baseline` | Project starting knowledge |

---

## Collection Tree

| Collection | Purpose | Auto-Delete | Priority |
|------------|---------|-------------|----------|
| `critical/` | Never delete, time-sensitive | ❌ | 0.30 |
| `core/` | Core facts, decisions | ❌ | 0.25 |
| `plan/` | Planning, architecture | ❌ | 0.22 |
| `spec/` | Specifications | ❌ | 0.20 |
| `important/` | Important but not critical | ❌ | 0.15 |
| `progress/` | Resume tracker (never delete) | ❌ | 0.12 |
| `tasks/` | Task solutions, TODOs | ✅ on-done | 0.10 |
| `prompts/` | User prompts history | ✅ 90 days | 0.05 |
| `casual/` | Conversations, brief mentions | ✅ 30 days | 0.00 |

---

## What Gets Stored

**Pre-LLM (automatic):**
- Relevant memories from past conversations
- Project-specific knowledge
- Previous decisions and solutions

**Post-LLM (automatic):**
- Conversation learnings after compaction
- Problem → solution pairs
- User preferences (if captured)

**Manual Storage:**
- User asks to "remember this"
- Development fixes and root causes
- AI rules and constraints

---

## Memory Architecture

```
.memory/
├── agents-memory/
│   ├── daemon.sock    # IPC socket
│   ├── daemon.pid     # Process ID
│   └── chroma.sqlite3 # Vector database
└── chroma/            # Legacy (deprecated)
```

---

## Troubleshooting

**Collection not found**: Run bootstrap first
```bash
python3 $SKILL_DIR/memory_bootstrap.py <project>
```

**Slow search**: Model caching after first load (~5s)

**Empty results**: Memory is empty — start using write to populate

---

_Works everywhere. Remembers everything._
