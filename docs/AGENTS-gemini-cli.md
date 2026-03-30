# AGENTS.md for Gemini CLI (Google AI CLI)

## Memory Integration

This AGENTS.md is automatically loaded by Gemini CLI when starting a session in this project.

### Semantic Memory Pipeline (WAJIB)

**ALWAYS RUN. NO SKIP.**

### Pipeline Flow

```
Task arrives
    ↓
1. PRE-LLM → Query Chroma for relevant context
    ↓
2. INJECT context into prompt
    ↓
3. AI processes task
    ↓
4. POST-LLM → Store learnings to Chroma
    ↓
Response
```

### Memory Commands

```bash
# Memory directory (set once)
export MEMORY_DIR="$HOME/.memory/chroma"
export SKILL_DIR="/srv/apps/semantic-clawmemory/skill"

# PRE-LLM: Query relevant context
python3 $SKILL_DIR/memory_search.py "<task description>" --project <project_name> --limit 5

# POST-LLM: Store learnings  
python3 $SKILL_DIR/memory_write.py "<problem>" --solution "<solution>" --type solution --project <project_name>

# Bootstrap new project
python3 $SKILL_DIR/memory_bootstrap.py <project_name> --architecture "<description>"
```

### Entry Types

| Type | Description |
|------|-------------|
| `solution` | Problem → solution pair |
| `skill` | Reusable skill or technique |
| `fact` | Factual information |
| `decision` | Architectural/design decision |
| `baseline` | Project baseline knowledge |
| `chat` | Conversation summary |

### Collections

- `critical/` - Critical info, never delete
- `core/` - Core project knowledge
- `important/` - Important but not critical
- `tasks/` - Task-specific solutions
- `casual/` - Casual conversations
- `prompts/` - Saved prompts/templates
- `progress/` - Progress tracking

### Quick Commands

```bash
# Search memory
cd /srv/apps/semantic-clawmemory/skill && python3 memory_search.py "your query"

# Write to memory
cd /srv/apps/semantic-clawmemory/skill && python3 memory_write.py "problem" --solution "solution"

# GC and stats
cd /srv/apps/semantic-clawmemory/skill && python3 memory_gc.py --stats

# Intelligence
cd /srv/apps/semantic-clawmemory/scripts && python3 intelligence.py patterns
```

### Project Context

When starting a new Gemini CLI session:
1. Check if project has existing memory: `python3 memory_search.py "project baseline" --project <name>`
2. If memory empty → run bootstrap: `python3 memory_bootstrap.py <name> --architecture "<desc>"`
3. Load relevant context before major tasks

---

_This file is auto-generated. Do not edit manually._
