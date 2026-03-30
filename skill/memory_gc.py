#!/usr/bin/env python3
"""
memory_gc.py - Memory garbage collection and maintenance
Usage: memory_gc.py [--dedup] [--decay] [--archive] [--trash]

Maintenance tasks:
- dedup: Remove duplicate entries
- decay: Lower importance of rarely used entries
- archive: Move old entries to archive
- trash: Permanently delete old trash entries
"""

import sys
import json
import argparse
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

try:
    import chromadb
    from chromadb.utils import embedding_functions
except ImportError:
    print("ERROR: chromadb not installed. Run: pip install chromadb sentence-transformers")
    sys.exit(1)


def get_settings():
    """Load settings."""
    config_dir = Path(__file__).parent.parent / "config"
    settings_file = config_dir / "settings.yaml"
    
    if settings_file.exists():
        import yaml
        with open(settings_file) as f:
            return yaml.safe_load(f)
    
    return {
        "gc": {
            "dedup_interval_days": 7,
            "archive_after_days": 90,
            "trash_retention_days": 30
        },
        "chroma": {
            "persist_directory": "~/.memory/chroma",
            "embedding_model": "all-MiniLM-L6-v2"
        }
    }


COLLECTIONS = ["critical", "core", "important", "tasks", "casual", "prompts", "progress"]


def gc_dedup():
    """Remove duplicate entries based on content similarity."""
    settings = get_settings()
    persist_dir = Path(settings["chroma"]["persist_directory"]).expanduser()
    
    ef = embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name=settings["chroma"]["embedding_model"]
    )
    
    client = chromadb.PersistentClient(path=str(persist_dir))
    
    removed = 0
    for col_name in COLLECTIONS:
        try:
            collection = client.get_collection(name=col_name, embedding_function=ef)
            all_data = collection.get()
            
            # Group by content similarity (simple exact match for now)
            seen = {}
            to_delete = []
            
            for i, doc in enumerate(all_data.get("documents", [])):
                # Use first 200 chars as dedup key
                key = doc[:200].lower().strip()
                if key in seen:
                    # Keep the one with higher use_count
                    existing_idx = seen[key]
                    existing_meta = all_data["metadatas"][existing_idx]
                    current_meta = all_data["metadatas"][i]
                    
                    if current_meta.get("use_count", 0) > existing_meta.get("use_count", 0):
                        to_delete.append(all_data["ids"][existing_idx])
                        seen[key] = i
                    else:
                        to_delete.append(all_data["ids"][i])
                else:
                    seen[key] = i
            
            if to_delete:
                collection.delete(ids=to_delete)
                removed += len(to_delete)
                
        except Exception as e:
            pass
    
    return {"dedup": {"removed": removed}}


def gc_decay():
    """Lower importance of rarely used entries over time."""
    settings = get_settings()
    persist_dir = Path(settings["chroma"]["persist_directory"]).expanduser()
    
    ef = embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name=settings["chroma"]["embedding_model"]
    )
    
    client = chromadb.PersistentClient(path=str(persist_dir))
    
    decayed = 0
    for col_name in COLLECTIONS:
        try:
            collection = client.get_collection(name=col_name, embedding_function=ef)
            all_data = collection.get()
            
            to_update = []
            for i, meta in enumerate(all_data.get("metadatas", [])):
                last_used = datetime.fromisoformat(meta.get("last_used", "2020-01-01"))
                days_since_use = (datetime.now() - last_used).days
                
                if days_since_use > 30:
                    # Decay importance
                    current_importance = meta.get("importance", 0.5)
                    decay_factor = min(days_since_use / 90, 0.5)  # Max 50% decay
                    new_importance = current_importance * (1 - decay_factor)
                    
                    if new_importance < current_importance:
                        to_update.append({
                            "id": all_data["ids"][i],
                            "importance": new_importance,
                            "use_count": meta.get("use_count", 0),
                            "last_used": meta.get("last_used")
                        })
                        decayed += 1
            
            # Batch update
            for entry in to_update:
                collection.update(
                    ids=[entry["id"]],
                    metadatas=[{
                        **entry,
                        "importance": entry["importance"],
                        "decayed": True
                    }]
                )
                
        except Exception as e:
            pass
    
    return {"decay": {"decayed": decayed}}


def gc_trash():
    """Permanently delete old trash entries."""
    # TODO: Implement trash collection
    # Currently using soft delete, need trash collection
    return {"trash": {"message": "Trash collection not yet implemented"}}


def gc_stats():
    """Get memory statistics."""
    settings = get_settings()
    persist_dir = Path(settings["chroma"]["persist_directory"]).expanduser()
    
    ef = embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name=settings["chroma"]["embedding_model"]
    )
    
    client = chromadb.PersistentClient(path=str(persist_dir))
    
    stats = {}
    total = 0
    for col_name in COLLECTIONS:
        try:
            collection = client.get_collection(name=col_name, embedding_function=ef)
            count = collection.count()
            stats[col_name] = count
            total += count
        except:
            stats[col_name] = 0
    
    stats["_total"] = total
    return {"stats": stats}


def main():
    parser = argparse.ArgumentParser(description="Memory garbage collection")
    parser.add_argument("--dedup", action="store_true", help="Remove duplicates")
    parser.add_argument("--decay", action="store_true", help="Decay rarely used entries")
    parser.add_argument("--trash", action="store_true", help="Clean trash")
    parser.add_argument("--stats", action="store_true", help="Show statistics")
    parser.add_argument("--all", action="store_true", help="Run all gc tasks")
    
    args = parser.parse_args()
    
    results = {}
    
    if args.stats or args.all:
        results.update(gc_stats())
    
    if args.dedup or args.all:
        results.update(gc_dedup())
    
    if args.decay or args.all:
        results.update(gc_decay())
    
    if args.trash or args.all:
        results.update(gc_trash())
    
    if not results:
        # Default: show stats
        results = gc_stats()
    
    print(json.dumps(results, indent=2, default=str))


if __name__ == "__main__":
    main()
