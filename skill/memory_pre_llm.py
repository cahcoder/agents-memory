#!/usr/bin/env python3
"""
memory_pre_llm.py - PRE-LLM hook: Query Chroma + inject context
Usage: memory_pre_llm.py <user_input> [--project <name>]

Returns context to inject into prompt before AI processes the input.
"""

import sys
import json
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "skill"))

from memory_search import memory_search


def memory_pre_llm(user_input: str, project: str = None):
    """
    PRE-LLM hook:
    1. Query Chroma for relevant context
    2. Format for prompt injection
    3. Return context string
    """
    
    # Query for relevant context
    results = memory_search(
        query=user_input,
        project=project,
        limit=10
    )
    
    if not results:
        return {
            "has_context": False,
            "context": "",
            "entries_found": 0
        }
    
    # Format context for injection
    context_parts = ["\n\n=== RELEVANT MEMORY CONTEXT ===\n"]
    
    for i, r in enumerate(results, 1):
        meta = r.get("metadata", {})
        content = r.get("content", "")
        col = r.get("collection", "unknown")
        
        context_parts.append(f"\n--- Context {i} [{col}] ---")
        if meta.get("project"):
            context_parts.append(f"Project: {meta['project']}")
        if meta.get("entry_type"):
            context_parts.append(f"Type: {meta['entry_type']}")
        context_parts.append(f"\n{content}\n")
    
    context_parts.append("\n=== END MEMORY CONTEXT ===\n")
    
    return {
        "has_context": True,
        "context": "".join(context_parts),
        "entries_found": len(results),
        "entries": results
    }


def main():
    parser = argparse.ArgumentParser(description="PRE-LLM memory hook")
    parser.add_argument("input", help="User input or task description")
    parser.add_argument("--project", "-p", help="Project name")
    
    args = parser.parse_args()
    
    result = memory_pre_llm(args.input, args.project)
    
    # Output only the context string for easy injection
    # Full JSON available for structured processing
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
