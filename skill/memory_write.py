#!/usr/bin/env python3
"""
memory_write.py - Store new entry to Chroma
Usage: memory_write.py <problem> [--solution <code>] [--logic <explanation>]
       [--type <entry_type>] [--project <name>] [--language <lang>]
       [--importance <0.0-1.0>]
"""

import sys
import json
import argparse
import uuid
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

try:
    import chromadb
    from chromadb.utils import embedding_functions
except ImportError:
    print("ERROR: chromadb not installed. Run: pip install chromadb sentence-transformers")
    sys.exit(1)


def memory_write(
    problem: str,
    solution: str = None,
    logic_solution: str = None,
    entry_type: str = "chat",
    project: str = "default",
    language: str = None,
    importance: float = 0.5
):
    """Store new entry to Chroma."""
    
    config_dir = Path(__file__).parent.parent / "config"
    settings_file = config_dir / "settings.yaml"
    
    # Load settings
    if settings_file.exists():
        import yaml
        with open(settings_file) as f:
            settings = yaml.safe_load(f)
    else:
        settings = {
            "chroma": {
                "persist_directory": "~/.memory/chroma",
                "embedding_model": "all-MiniLM-L6-v2",
                "dimensions": 384
            }
        }
    
    persist_dir = Path(settings["chroma"]["persist_directory"]).expanduser()
    
    # Initialize Chroma
    ef = embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name=settings["chroma"]["embedding_model"]
    )
    
    client = chromadb.PersistentClient(path=str(persist_dir))
    
    # Build text content
    content_parts = [f"Problem: {problem}"]
    if solution:
        content_parts.append(f"Solution: {solution}")
    if logic_solution:
        content_parts.append(f"Logic: {logic_solution}")
    content = "\n\n".join(content_parts)
    
    # Metadata
    metadata = {
        "project": project,
        "entry_type": entry_type,
        "use_count": 0,
        "last_used": datetime.now().isoformat(),
        "importance": importance,
        "language": language or "unknown"
    }
    
    # Determine collection by entry_type
    type_to_collection = {
        "solution": "tasks",
        "skill": "tasks",
        "fact": "important",
        "decision": "progress",
        "baseline": "core",
        "chat": "casual",
        "prompt": "prompts"
    }
    
    collection_name = type_to_collection.get(entry_type, "casual")
    
    try:
        collection = client.get_or_create_collection(
            name=collection_name,
            embedding_function=ef
        )
        
        entry_id = str(uuid.uuid4())
        collection.add(
            ids=[entry_id],
            documents=[content],
            metadatas=[metadata]
        )
        
        return {"id": entry_id, "collection": collection_name, "status": "stored"}
        
    except Exception as e:
        return {"error": str(e), "status": "failed"}


def main():
    parser = argparse.ArgumentParser(description="Write to semantic memory")
    parser.add_argument("problem", help="Problem or topic description")
    parser.add_argument("--solution", "-s", help="Solution or answer")
    parser.add_argument("--logic", "-l", help="Logic/explanation")
    parser.add_argument("--type", "-t", default="chat", help="Entry type")
    parser.add_argument("--project", "-p", default="default", help="Project name")
    parser.add_argument("--language", help="Programming language")
    parser.add_argument("--importance", "-i", type=float, default=0.5, help="Importance 0.0-1.0")
    
    args = parser.parse_args()
    
    result = memory_write(
        problem=args.problem,
        solution=args.solution,
        logic_solution=args.logic,
        entry_type=args.type,
        project=args.project,
        language=args.language,
        importance=args.importance
    )
    
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
