#!/usr/bin/env python3
"""
memory_bootstrap.py - Write project baseline when memory is empty
Usage: memory_bootstrap.py <project_name> [--architecture <desc>]
       [--db <desc>] [--tech-stack <desc>] [--workflow <desc>]
       [--rules <desc>]

Enforces baseline memory write before any task when project memory is empty.
"""

import sys
import json
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "skill"))

from memory_search import memory_search
from memory_write import memory_write


# Baseline template fields
BASELINE_FIELDS = [
    ("project_architecture", "How the project is structured, main components"),
    ("db_architecture", "Database schema, tables, relationships, roles"),
    ("tech_stack", "Languages, frameworks, tools used"),
    ("build_rebuild_workflow", "How to build, rebuild, deploy the project"),
    ("codebase_index", "Key files, where to find what"),
    ("system_rules", "Important rules, conventions, constraints"),
    ("decisions_log", "Key decisions made and why"),
]


def check_project_memory_empty(project: str) -> bool:
    """Check if project has any memory entries."""
    
    results = memory_search(
        query=f"project {project}",
        project=project,
        limit=1
    )
    
    return len(results) == 0


def memory_bootstrap(
    project: str,
    architecture: str = None,
    db_architecture: str = None,
    tech_stack: str = None,
    workflow: str = None,
    codebase_index: str = None,
    system_rules: str = None,
    decisions_log: str = None
):
    """
    Write project baseline if memory is empty.
    
    Enforces: When project memory is empty, MUST write baseline before any task.
    """
    
    # Check if memory is empty
    if not check_project_memory_empty(project):
        return {
            "status": "skipped",
            "reason": f"Project '{project}' already has memory entries",
            "action": "Proceed with task"
        }
    
    # Write baseline fields
    stored = []
    
    fields_with_values = [
        ("project_architecture", architecture),
        ("db_architecture", db_architecture),
        ("tech_stack", tech_stack),
        ("build_rebuild_workflow", workflow),
        ("codebase_index", codebase_index),
        ("system_rules", system_rules),
        ("decisions_log", decisions_log),
    ]
    
    for field_name, field_value in fields_with_values:
        if field_value:  # Only store if provided
            result = memory_write(
                problem=f"Project baseline: {field_name}",
                solution=field_value,
                entry_type="baseline",
                project=project,
                importance=1.0  # Critical
            )
            stored.append({
                "field": field_name,
                "result": result
            })
    
    # If no values provided, return template for user to fill
    if not stored:
        template = "\n".join([
            f"- {name}: {desc}" for name, desc in BASELINE_FIELDS
        ])
        return {
            "status": "template_needed",
            "project": project,
            "template": template,
            "instruction": "Please provide values for baseline fields above"
        }
    
    return {
        "status": "stored",
        "project": project,
        "entries": stored
    }


def main():
    parser = argparse.ArgumentParser(description="Bootstrap project memory baseline")
    parser.add_argument("project", help="Project name")
    parser.add_argument("--architecture", "-a", help="Project architecture description")
    parser.add_argument("--db", "-d", help="Database architecture")
    parser.add_argument("--tech-stack", "-t", help="Tech stack")
    parser.add_argument("--workflow", "-w", help="Build/rebuild workflow")
    parser.add_argument("--index", "-i", help="Codebase index")
    parser.add_argument("--rules", "-r", help="System rules")
    parser.add_argument("--decisions", help="Decisions log")
    parser.add_argument("--force", help="Force rewrite even if exists", action="store_true")
    
    args = parser.parse_args()
    
    # If --force, skip empty check
    if args.force:
        # Clear existing baselines for project
        # TODO: implement clear_project_memory
        pass
    
    result = memory_bootstrap(
        project=args.project,
        architecture=args.architecture,
        db_architecture=args.db,
        tech_stack=args.tech_stack,
        workflow=args.workflow,
        codebase_index=args.index,
        system_rules=args.rules,
        decisions_log=args.decisions
    )
    
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
