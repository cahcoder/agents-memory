#!/usr/bin/env python3
"""
memory-init.py - Initialize project context from MEMORY.md and AGENTS.md

Usage: memory-init [project_name]

This reads MEMORY.md and AGENTS.md for project context and injects as system message.
Useful when starting a new project or OpenClaw session.
"""

import sys
import os
import re
import json
from pathlib import Path

MEMORY_MD = Path.home() / ".openclaw" / "workspace" / "MEMORY.md"
AGENTS_MD = Path.home() / ".openclaw" / "workspace" / "AGENTS.md"


def read_file_safely(path):
    """Read file content safely."""
    try:
        return path.read_text()
    except FileNotFoundError:
        return ""


def read_memory_md(project_name=None):
    """Read MEMORY.md for general context."""
    if not MEMORY_MD.exists():
        return "No MEMORY.md found."
    
    content = read_file_safely(MEMORY_MD)
    
    # Filter by project if specified
    if project_name:
        # Find project-specific section (e.g., "## KSEI Stock Data Pipeline")
        pattern = rf"(^#+ .+{re.escape(project_name)}.|^\*\*{re.escape(project_name)}\*\*)"
        matches = list(re.finditer(pattern, content, re.MULTILINE | re.IGNORECASE))
        
        if matches:
            # Extract project section
            section_start = matches[0].start()
            section_end = matches[0].end() + 1 if len(matches) > 1 else len(content)
            
            # Find next section or end of file
            next_heading = re.search(r'\n## ', content[section_end:])
            section_end = next_heading.start() if next_heading else len(content)
            
            project_content = content[section_start:section_end].strip()
        else:
            # Return general context (first section only)
            next_heading = re.search(r'\n## ', content)
            if next_heading:
                project_content = content[:next_heading.start()].strip()
            else:
                project_content = content.strip()
    else:
        # Return general context (first section only)
        next_heading = re.search(r'\n## ', content)
        if next_heading:
            project_content = content[:next_heading.start()].strip()
        else:
            project_content = content.strip()
    
    return project_content


def read_agents_md(project_name=None):
    """Read AGENTS.md for project context."""
    if not AGENTS_MD.exists():
        return ""
    
    content = read_file_safely(AGENTS_MD)
    
    # Filter by project if specified
    if project_name:
        # Find project-specific section
        pattern = rf"(^## {re.escape(project_name)}$|^{re.escape(project_name)}.*)$"
        matches = list(re.finditer(pattern, content, re.MULTILINE | re.IGNORECASE))
        
        if matches:
            # Extract project section
            project_content = content[matches[0].start():matches[0].end()].strip()
        else:
            return ""
    else:
        return ""
    
    return project_content


def main():
    import json
    
    project_name = sys.argv[1] if len(sys.argv) > 1 else None
    
    # Read both files
    project_context = read_agents_md(project_name)
    general_context = read_memory_md(project_name)
    
    # Combine both
    contexts = [c for c in [project_context, general_context] if c]
    combined_context = "\n\n".join(contexts)
    
    if not combined_context.strip():
        return json.dumps({
            "error": "No context found in MEMORY.md or AGENTS.md",
            "error_detail": f"Project: {project_name}"
        }, indent=2)
    
    # Output as OpenClaw-compatible system message
    print(json.dumps({
        "messages": [{
            "role": "system",
            "content": f"Context from MEMORY.md and AGENTS.md:\n{combined_context}"
        }]
    }, indent=2))


if __name__ == "__main__":
    main()
