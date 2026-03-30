# Memory Design Architecture

## Vision

> "Grows the Longer It Runs" - An AI memory system that continuously learns, never forgets, and improves over time.

Memory is not just storage. Memory is what makes an AI agent feel **aware**, **consistent**, and **intelligent** across sessions.

## Problem

1. **Context overflow** - AI "gibbers" when context is too large (especially GLM-5)
2. **Forgetting** - AI forgets solutions, decisions, preferences between sessions
3. **Repetition** - Same problems solved repeatedly without learning
4. **Context loss** - Chat history not enough; AI needs semantic understanding

## Solution: Semantic Memory Layer

```
┌─────────────────────────────────────────────────────────────┐
│ EVERY prompt/task goes through memory layer                  │
│ No skip. No manual. Always on.                               │
└─────────────────────────────────────────────────────────────┘
```

### Pre-LLM + Post-LLM Memory Cycle

```
USER INPUT
    ↓
┌───────────────────────────────────┐
│ PRE-LLM                            │
│ → Query Chroma (relevant context)  │
│ → Inject into prompt               │
│ → AI is context-aware              │
└───────────────────────────────────┘
    ↓
AI PROCESS
    ↓
┌───────────────────────────────────┐
│ POST-LLM                           │
│ → Analyze response: new learning?  │
│ → If yes → store to Chroma         │
│   (new fact, solution, pattern)   │
│ → Update use_count (for retrieval) │
└───────────────────────────────────┘
    ↓
RESPONSE TO USER
```

### Continuous Learning Loop

```
Session 1: AI solves X → Post-LLM stores → Chroma has X
Session 2: AI encounters X → Pre-LLM loads → AI remembers
Session 3+: AI handles X faster (from memory)
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ OpenClaw / AI CLI                                            │
│                                                              │
│ AGENTS.md (enforcement)                                      │
│  → Memory pipeline runs automatically                        │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Semantic Memory Plugin                                       │
│                                                              │
│ skill/                                                       │
│ ├── memory_search.py      → Query Chroma                     │
│ ├── memory_write.py       → Store entry                     │
│ ├── memory_pre_llm.py     → PRE-LLM hook                     │
│ ├── memory_post_llm.py    → POST-LLM hook                   │
│ ├── memory_bootstrap.py   → Baseline enforcement             │
│ └── memory_gc.py          → Maintenance                      │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Chroma DB (Embedded DuckDB)                                   │
│                                                              │
│ ~/.memory/chroma/                                            │
│  └── collections/                                            │
│      ├── critical/                                           │
│      ├── core/                                               │
│      ├── important/                                          │
│      ├── tasks/                                              │
│      ├── casual/                                             │
│      ├── prompts/                                            │
│      └── progress/                                           │
└─────────────────────────────────────────────────────────────┘
```

## Collections (Domain-Separated)

| Collection | Purpose | Importance |
|------------|---------|------------|
| `critical/` | Critical info, never delete | 1.0 (locked) |
| `core/` | Core project knowledge, baseline | High |
| `important/` | Important but not critical | Medium-High |
| `tasks/` | Task solutions, skills | Medium |
| `casual/` | Casual conversations, preferences | Low-Medium |
| `prompts/` | Saved prompts, templates | Medium |
| `progress/` | Progress tracking, decisions | Medium |

## Entry Schema

```json
{
  "id": "uuid",
  "project": "project_name",
  "entry_type": "solution | skill | fact | decision | baseline | chat | prompt",
  "problem": "description (searchable)",
  "solution": "sample code or answer (generic template)",
  "logic_solution": "why/how it works",
  "language": "python | bash | sql | yaml | ...",
  "use_count": 0,
  "last_used": "timestamp",
  "importance": 0.0-1.0,
  "timestamp": "when stored"
}
```

### Entry Types

- **solution**: Problem solved with generic sample code
- **skill**: Reusable pattern (3+ solves)
- **fact**: Factual information learned
- **decision**: Decision made and rationale
- **baseline**: Project baseline (architecture, tech stack, etc)
- **chat**: Casual conversation, preferences
- **prompt**: Saved prompt template

## Sample Code Storage

Store **generic templates**, NOT exact copies:

```
❌ BAD (garbage):
   docker exec -it postgres_prod_001 pg_ctl restart...
   docker exec -it postgres_backup_002 pg_ctl restart...
   → 100 variations = GARBAGE

✅ GOOD (template):
   docker exec -it {container_name} pg_ctl restart -D {data_dir}
   → 1 entry = reusable pattern
```

## Self-Improvement Loop

```
Problem solved (custom code, executed)
    ↓
Same pattern 3x detected
    ↓
AI writes GENERIC sample code
    ↓
Stores to Chroma with logic_solution
    ↓
Next time: AI uses template → adapts to context
```

## Enforcement

### OpenClaw: AGENTS.md

```markdown
## Memory Pipeline (WAJIB)

1. On task → memory_search (PRE-LLM)
2. Execute task
3. After response → memory_write (POST-LLM)

No skip. No manual. Always on.
```

### Other AI CLIs: Wrapper

```bash
# ~/.bashrc
alias opencode='memory-wrapper opencode'
alias gemini='memory-wrapper gemini'
```

Wrapper intercepts, runs Pre/Post hooks, calls actual CLI.

## Installation

```bash
# OpenClaw
openclaw plugin install semantic-memory

# Or manual
cp -r skill/* ~/.openclaw/skills/semantic-memory/
```

## Usage

```bash
# Query memory
memory_search "how to restart postgres"

# Write to memory
memory_write "postgres crash" --solution "docker restart pattern" --type solution

# Bootstrap project baseline
memory_bootstrap myproject --architecture "..." --tech-stack "..."

# Garbage collection
memory_gc --all

# Stats
memory_gc --stats
```

## Configuration

Edit `config/settings.yaml`:

```yaml
chroma:
  persist_directory: "~/.memory/chroma"
  embedding_model: "all-MiniLM-L6-v2"

gc:
  dedup_interval_days: 7
  archive_after_days: 90
  trash_retention_days: 30
```

## Tech Stack

| Component | Choice |
|-----------|--------|
| Language | Python 3.x |
| Embedding | sentence-transformers / all-MiniLM-L6-v2 (384 dims) |
| Vector DB | Chroma (embedded mode, DuckDB + Parquet) |
| ANN Algorithm | HNSW (M=32-48, ef=200-300) |
| Search | Cosine similarity, ANN (not exact kNN) |

**Why Chroma:**
- Embedded mode = no daemon
- Works out of box
- Good for 300K+ entries
- Simple Python API

## Status

- [x] Design complete
- [ ] Implementation (OpenClaw plugin)
- [ ] Test with real usage
- [ ] Generalize to other AI CLIs
