#!/usr/bin/env python3
"""
memory_search.py - Query Chroma for relevant context
Usage: memory_search.py <query> [--project <name>] [--type <entry_type>] [--limit <n>]
"""

import sys
import json
import argparse
from pathlib import Path

# Add scripts to path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

try:
    import chromadb
    from chromadb.utils import embedding_functions
except ImportError:
    print("ERROR: chromadb not installed. Run: pip install chromadb sentence-transformers")
    sys.exit(1)


def memory_search(query: str, project: str = None, entry_type: str = None, limit: int = 5):
    """Query Chroma for relevant context."""
    
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
    
    # Query relevant collections
    collections_to_query = ["critical", "core", "important", "tasks", "casual", "prompts", "progress"]
    results = []
    
    for col_name in collections_to_query:
        try:
            collection = client.get_collection(name=col_name, embedding_function=ef)
            
            # Build where clause
            where = {}
            if project:
                where["project"] = project
            if entry_type:
                where["entry_type"] = entry_type
            
            # Query
            query_results = collection.query(
                query_texts=[query],
                n_results=limit,
                where=where if where else None
            )
            
            # Format results
            for i, doc in enumerate(query_results.get("documents", [[]])[0]):
                meta = query_results.get("metadatas", [[]])[0][i] if query_results.get("metadatas") else {}
                results.append({
                    "collection": col_name,
                    "content": doc,
                    "metadata": meta,
                    "distance": query_results.get("distances", [[]])[0][i] if query_results.get("distances") else None
                })
                
        except Exception as e:
            # Collection might not exist
            pass
    
    # Sort by distance (lower = more relevant)
    results.sort(key=lambda x: x.get("distance") or 999)
    
    return results[:limit]


def main():
    parser = argparse.ArgumentParser(description="Query semantic memory")
    parser.add_argument("query", help="Search query")
    parser.add_argument("--project", "-p", help="Filter by project")
    parser.add_argument("--type", "-t", help="Filter by entry type")
    parser.add_argument("--limit", "-n", type=int, default=5, help="Number of results")
    
    args = parser.parse_args()
    
    results = memory_search(args.query, args.project, args.type, args.limit)
    
    if not results:
        print("[]")
        return
    
    print(json.dumps(results, indent=2, default=str))


if __name__ == "__main__":
    main()
