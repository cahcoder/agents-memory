#!/usr/bin/env python3
"""
chroma_client.py - Shared ChromaDB client for semantic-clawmemory
"""

import sys
import os
from pathlib import Path
from datetime import datetime

try:
    import chromadb
    from chromadb.utils import embedding_functions
except ImportError:
    print("ERROR: chromadb not installed. Run: pip install chromadb sentence-transformers")
    sys.exit(1)

# Resolve home directory
def expand_path(path_str):
    if path_str.startswith("~/"):
        return str(Path.home() / path_str[2:])
    return path_str

def get_settings():
    """Load settings from config."""
    config_dir = Path(__file__).parent.parent / "config"
    settings_file = config_dir / "settings.yaml"
    
    if settings_file.exists():
        import yaml
        with open(settings_file) as f:
            return yaml.safe_load(f)
    
    return {
        "chroma": {
            "persist_directory": "~/.memory/chroma",
            "embedding_model": "all-MiniLM-L6-v2",
            "dimensions": 384
        }
    }

def get_chroma_client():
    """Get or create ChromaDB client."""
    settings = get_settings()
    chroma_config = settings.get("chroma", {})
    
    persist_dir = expand_path(chroma_config.get("persist_directory", "~/.memory/chroma"))
    model_name = chroma_config.get("embedding_model", "all-MiniLM-L6-v2")
    
    # Create directory if not exists
    Path(persist_dir).mkdir(parents=True, exist_ok=True)
    
    # Create persistent client
    client = chromadb.PersistentClient(path=persist_dir)
    
    # Embedding function
    embed_fn = embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name=model_name,
        device="cpu"
    )
    
    return client, embed_fn

def get_or_create_collection(client, embed_fn, name, metadata=None):
    """Get or create a collection."""
    try:
        return client.get_collection(name=name, embedding_function=embed_fn)
    except Exception:
        # Don't create with empty metadata - let it fail gracefully
        if metadata:
            return client.create_collection(
                name=name,
                embedding_function=embed_fn,
                metadata=metadata
            )
        else:
            # Try without metadata
            try:
                return client.create_collection(
                    name=name,
                    embedding_function=embed_fn
                )
            except Exception:
                # Last resort - just get (will error if doesn't exist)
                return client.get_collection(name=name, embedding_function=embed_fn)

# Collection names
COLLECTIONS = {
    "critical": {"name": "critical", "description": "Critical info, never delete"},
    "core": {"name": "core", "description": "Core project knowledge"},
    "important": {"name": "important", "description": "Important but not critical"},
    "tasks": {"name": "tasks", "description": "Task-specific solutions"},
    "casual": {"name": "casual", "description": "Casual conversations"},
    "prompts": {"name": "prompts", "description": "Saved prompts/templates"},
    "progress": {"name": "progress", "description": "Progress tracking"}
}

def get_all_collections(client, embed_fn):
    """Get all memory collections."""
    collections = {}
    for key, info in COLLECTIONS.items():
        collections[key] = get_or_create_collection(
            client, embed_fn, info["name"]
        )
    return collections

def get_timestamp():
    """Get current timestamp."""
    return datetime.now().isoformat()
