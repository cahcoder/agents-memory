---
name: agents-memory
description: "Semantic memory integration - queries ChromaDB for relevant context"
metadata:
  {
    "openclaw": {
      "emoji": "🧠",
      "events": ["message:preprocessed", "session:compact:after"],
      "requires": { "bins": ["python3"] }
    }
  }
---

# agents-memory

Queries ChromaDB for relevant context and injects into conversation.

## Events

- `message:preprocessed` - Query memory before LLM call
- `session:compact:after` - Store learnings after compaction

## Installation

This hook requires the agents-memory daemon to be running:

```bash
agents-memory daemon
```

Or via systemd service (if installed).
