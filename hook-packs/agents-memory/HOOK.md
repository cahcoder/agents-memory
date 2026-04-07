# agents-memory Hook

Auto-save hook for OpenClaw that captures conversations and saves to semantic memory.

## Collection System

Both user message AND AI response go to the **same collection** based on what the user is asking about.

### Collections

| Collection | When to Save | Keywords/Patterns |
|------------|--------------|-------------------|
| **laws** | User says "make this a rule/guideline" | `make this a rule`, `guideline`, `workflow`, `always do`, `never do` |
| **tasks** | User asks how to do something | `how to`, `how do`, `what is`, `explain`, `help me`, `fix`, `debug`, `why`, `can you` |
| **progress** | Task completed / milestone hit | `done`, `finished`, `completed`, `fixed`, `solved`, `working now` |
| **plan** | Future intentions / roadmap | `will`, `going to`, `plan to`, `next step`, `roadmap`, `should do` |
| **important** | Key facts / preferences | `remember`, `important`, `preference`, `don't forget` |
| **core** | Baseline knowledge / architecture | architecture, project structure, tech stack decisions |
| **casual** | Casual conversation | greetings, small talk, `thanks`, `ok`, `hello` |
| **prompts** | Default for questions | Anything that doesn't match above |
| **working** | AI responses | Always saved for paired conversations |

### Type Mapping (Hook → Daemon)

The hook sends types that the daemon maps to collections:

| Hook Collection | Daemon Type | Goes To |
|----------------|-------------|---------|
| `tasks` | `solution` | tasks |
| `progress` | `summary` | progress |
| `plan` | `decision` | progress |
| `important` | `fact` | important |
| `core` | `baseline` | core |
| `laws` | `law` | laws |
| `casual` | `chat` | casual |
| `prompts` | `prompt` | prompts |
| `working` | `working` | working |

## Save Flow

```
1. User sends message
2. Hook checks if PREVIOUS user message has AI response → saves paired to collection
3. Hook sets current message as PENDING (waiting for AI response)
4. User sends next message
5. Hook saves paired (previous user + AI response) to SAME collection
6. Repeat
```

**Note:** Pairing happens on the NEXT user message because there's no POST-LLM hook. The pending system ensures user+AI are paired together.

## Stale Handling

If user doesn't send another message within 2 minutes, the pending message is saved as stale (no AI response).

## Installation

Copy `handler.js` to:
```
~/.openclaw/hooks/agents-memory/handler.js
```

Or use the hook-pack:
```
~/.openclaw/hooks/agents-memory/
```

## Configuration

No additional configuration needed. The hook reads the daemon socket path from environment:
```
~/.memory/agents-memory/daemon.sock
```
