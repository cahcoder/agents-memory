#!/usr/bin/env python3
"""
intelligence.py - Self-improvement loop for semantic-clawmemory

Features:
- Pattern detection (3x same problem)
- Auto-importance boost
- Template generation
- Cross-project learning
"""

import sys
from pathlib import Path
from collections import defaultdict
from datetime import datetime, timedelta

sys.path.insert(0, str(Path(__file__).parent))
from chroma_client import get_chroma_client, get_all_collections, get_timestamp, expand_path, COLLECTIONS

# Settings
SETTINGS = {
    "pattern_threshold": 3,  # Same problem seen 3x = pattern
    "boost_amount": 0.15,     # Importance boost per use
    "decay_rate": 0.05,       # Importance decay per month
    "min_importance": 0.1,    # Floor for importance
    "max_importance": 1.0,   # Ceiling for importance
    "template_threshold": 0.7 # Similarity threshold for template gen
}

def detect_patterns(project=None, limit=100):
    """
    Detect patterns: same/similar problem solved multiple times.
    Returns entries that appear 3+ times with increasing use_count.
    """
    client, embed_fn = get_chroma_client()
    
    patterns = []
    
    for col_name in COLLECTIONS.keys():
        try:
            collection = client.get_collection(name=col_name, embedding_function=embed_fn)
        except Exception:
            continue
        
        # Query recent entries
        try:
            results = collection.get(limit=limit)
        except Exception:
            continue
        
        if not results or not results.get("ids"):
            continue
        
        # Group by problem/solution similarity
        problem_groups = defaultdict(list)
        
        for i, entry_id in enumerate(results["ids"]):
            metadata = results.get("metadata", [{}])[i] if results.get("metadata") else {}
            
            # Filter by project if specified
            if project and metadata.get("project") != project:
                continue
            
            # Look for entries with use_count >= threshold
            use_count = metadata.get("use_count", 0)
            
            if use_count >= SETTINGS["pattern_threshold"]:
                docs = results.get("documents", [""])
                problem = docs[i] if i < len(docs) else ""
                if problem:
                    # Normalize problem text for grouping
                    normalized = normalize_text(problem)
                    problem_groups[normalized].append({
                        "id": entry_id,
                        "problem": problem,
                        "solution": docs[i] if i < len(docs) else "",
                        "use_count": use_count,
                        "importance": metadata.get("importance", 0.5),
                        "project": metadata.get("project", "unknown")
                    })
        
        # Find groups with multiple entries (same pattern across projects)
        for normalized, entries in problem_groups.items():
            if len(entries) >= 1:  # Same problem in same project = pattern
                patterns.append({
                    "problem": entries[0]["problem"],
                    "solutions": list(set(e["solution"] for e in entries)),
                    "use_count": max(e["use_count"] for e in entries),
                    "projects": list(set(e["project"] for e in entries)),
                    "avg_importance": sum(e["importance"] for e in entries) / len(entries)
                })
    
    return patterns

def normalize_text(text):
    """Normalize text for pattern detection."""
    if not text:
        return ""
    # Lowercase, remove extra whitespace, strip common variations
    text = text.lower().strip()
    text = " ".join(text.split())
    # Remove variable parts (numbers, paths, IDs)
    import re
    text = re.sub(r'\d+', 'N', text)
    text = re.sub(r'/[^\s]+', '/PATH', text)
    text = re.sub(r'@[^\s]+', '@USER', text)
    return text

def auto_boost_importance(entry_id, collection_name, boost_amount=None):
    """Boost importance of an entry."""
    if boost_amount is None:
        boost_amount = SETTINGS["boost_amount"]
    
    client, embed_fn = get_chroma_client()
    collection = client.get_collection(name=collection_name, embedding_function=embed_fn)
    
    # Get current metadata
    try:
        entry = collection.get(ids=[entry_id])
        if not entry or not entry.get("ids"):
            return None
        
        current_importance = entry["metadata"][0].get("importance", 0.5)
        new_importance = min(SETTINGS["max_importance"], 
                             current_importance + boost_amount)
        
        # Update
        collection.update(
            ids=[entry_id],
            metadatas=[{
                **entry["metadata"][0],
                "importance": new_importance,
                "last_boosted": get_timestamp()
            }]
        )
        
        return new_importance
    except Exception:
        return None

def decay_importance(days_old=30, min_use_count=0):
    """
    Apply importance decay to old, rarely used entries.
    Called periodically by gc.
    """
    client, embed_fn = get_chroma_client()
    collections = get_all_collections(client, embed_fn)
    
    decayed_count = 0
    
    for col_name, collection in collections.items():
        try:
            # Skip critical collection
            if col_name == "critical":
                continue
            
            entries = collection.get()
            if not entries or not entries.get("ids"):
                continue
            
            for i, entry_id in enumerate(entries["ids"]):
                all_metadata = entries.get("metadata", []); metadata = all_metadata[i] if i < len(all_metadata) else {}
                
                # Skip frequently used entries
                use_count = metadata.get("use_count", 0)
                if use_count > min_use_count:
                    continue
                
                # Check age
                last_used_str = metadata.get("last_used", "")
                if not last_used_str:
                    continue
                
                try:
                    last_used = datetime.fromisoformat(last_used_str)
                    age_days = (datetime.now() - last_used).days
                    
                    if age_days >= days_old:
                        current_importance = metadata.get("importance", 0.5)
                        
                        # Calculate decay
                        decay_periods = age_days / 30  # Monthly decay
                        decay_amount = SETTINGS["decay_rate"] * decay_periods
                        new_importance = max(SETTINGS["min_importance"],
                                            current_importance - decay_amount)
                        
                        if new_importance < current_importance:
                            collection.update(
                                ids=[entry_id],
                                metadatas=[{
                                    **metadata,
                                    "importance": new_importance,
                                    "last_decayed": get_timestamp()
                                }]
                            )
                            decayed_count += 1
                except Exception:
                    continue
        except Exception:
            continue
    
    return decayed_count

def generate_template(solution_text, language="unknown"):
    """
    Generate a generic template from a concrete solution.
    E.g., "docker restart postgres" -> "docker restart {service_name}"
    """
    import re
    
    if not solution_text:
        return ""
    
    template = solution_text
    
    # Common variable patterns
    replacements = [
        # Service/container names
        (r'\bpostgres\b', '{service_name}'),
        (r'\bmysql\b', '{database_name}'),
        (r'\bredis\b', '{cache_name}'),
        # Path patterns
        (r'/home/[^\s/]+', '{user_home}'),
        (r'/var/[^\s/]+', '{var_path}'),
        (r'/srv/[^\s/]+', '{srv_path}'),
        (r'/tmp/[^\s/]+', '{tmp_path}'),
        # Number patterns
        (r'\b\d+\.\d+\.\d+\.\d+\b', '{ip_address}'),
        (r'\b\d{4,}\b', '{port}'),
        # Container/project names
        (r'--name\s+[^\s]+', '--name {container_name}'),
    ]
    
    for pattern, replacement in replacements:
        template = re.sub(pattern, replacement, template, flags=re.IGNORECASE)
    
    # Generic variable detection
    template = re.sub(r'\b[A-Z]{2,}\b', '{CONSTANT}', template)
    template = re.sub(r'\b[a-z]+_[a-z]+_[a-z]+\b', '{snake_case_var}', template)
    
    return template

def suggest_reusable_skills(project=None, min_use_count=3):
    """
    Suggest entries that could be reusable skills.
    High use_count + cross-project = good candidate for skill.
    """
    client, embed_fn = get_chroma_client()
    collections = get_all_collections(client, embed_fn)
    
    suggestions = []
    
    for col_name, collection in collections.items():
        try:
            entries = collection.get(limit=500)
        except Exception:
            continue
        
        if not entries or not entries.get("ids"):
            continue
        
        for i, entry_id in enumerate(entries["ids"]):
            all_metadata = entries.get("metadata", []); metadata = all_metadata[i] if i < len(all_metadata) else {}
            document = entries.get("documents", [""])[i]
            
            use_count = metadata.get("use_count", 0)
            entry_project = metadata.get("project", "unknown")
            entry_type = metadata.get("entry_type", "unknown")
            
            # Filter
            if use_count < min_use_count:
                continue
            if project and entry_project == project:
                continue  # Already in this project
            if entry_type not in ["solution", "skill"]:
                continue
            
            # Check if already exists in another project as skill
            # (would need to query - simplified for now)
            
            # Generate template
            template = generate_template(document)
            
            suggestions.append({
                "original": document[:100],
                "template": template if template != document else None,
                "use_count": use_count,
                "projects": [entry_project],
                "type": entry_type,
                "suggested_action": "Create skill" if template != document else "Mark as reusable"
            })
    
    # Sort by use_count
    suggestions.sort(key=lambda x: x["use_count"], reverse=True)
    return suggestions[:20]

def analyze_learning_velocity(days=7):
    """
    Analyze how fast knowledge is being accumulated.
    Returns stats about write rate and topic distribution.
    """
    client, embed_fn = get_chroma_client()
    collections = get_all_collections(client, embed_fn)
    
    cutoff = datetime.now() - timedelta(days=days)
    
    stats = {
        "period_days": days,
        "total_entries": 0,
        "by_collection": {},
        "by_type": defaultdict(int),
        "by_language": defaultdict(int),
        "avg_importance": 0,
        "projects": set()
    }
    
    importance_sum = 0
    count = 0
    
    for col_name, collection in collections.items():
        try:
            entries = collection.get(limit=10000)
        except Exception:
            continue
        
        if not entries or not entries.get("ids"):
            continue
        
        col_count = 0
        
        for i, entry_id in enumerate(entries["ids"]):
            all_metadata = entries.get("metadata", []); metadata = all_metadata[i] if i < len(all_metadata) else {}
            
            # Check timestamp
            timestamp_str = metadata.get("timestamp", "")
            if not timestamp_str:
                continue
            
            try:
                timestamp = datetime.fromisoformat(timestamp_str)
                if timestamp < cutoff:
                    continue
            except Exception:
                continue
            
            col_count += 1
            count += 1
            importance_sum += metadata.get("importance", 0.5)
            
            stats["by_type"][metadata.get("entry_type", "unknown")] += 1
            stats["by_language"][metadata.get("language", "unknown")] += 1
            if metadata.get("project"):
                stats["projects"].add(metadata["project"])
        
        if col_count > 0:
            stats["by_collection"][col_name] = col_count
            stats["total_entries"] += col_count
    
    if count > 0:
        stats["avg_importance"] = importance_sum / count
    
    stats["projects"] = list(stats["projects"])
    stats["by_type"] = dict(stats["by_type"])
    stats["by_language"] = dict(stats["by_language"])
    
    return stats

if __name__ == "__main__":
    import argparse
    import json
    
    parser = argparse.ArgumentParser(description="Intelligence module for semantic-clawmemory")
    subparsers = parser.add_subparsers(dest="command")
    
    # Patterns
    subparsers.add_parser("patterns", help="Detect patterns (repeated solutions)")
    
    # Velocity
    subparsers.add_parser("velocity", help="Analyze learning velocity")
    
    # Suggestions
    subparsers.add_parser("suggestions", help="Suggest reusable skills")
    
    # Boost
    boost_parser = subparsers.add_parser("boost", help="Boost entry importance")
    boost_parser.add_argument("entry_id", help="Entry ID")
    boost_parser.add_argument("--collection", default="tasks", help="Collection name")
    boost_parser.add_argument("--amount", type=float, help="Boost amount")
    
    # Decay
    decay_parser = subparsers.add_parser("decay", help="Apply importance decay")
    decay_parser.add_argument("--days", type=int, default=30, help="Entry age in days")
    
    args = parser.parse_args()
    
    if args.command == "patterns":
        patterns = detect_patterns()
        print(json.dumps(patterns, indent=2))
    elif args.command == "velocity":
        stats = analyze_learning_velocity()
        print(json.dumps(stats, indent=2))
    elif args.command == "suggestions":
        suggestions = suggest_reusable_skills()
        print(json.dumps(suggestions, indent=2))
    elif args.command == "boost":
        new_imp = auto_boost_importance(args.entry_id, args.collection, args.amount)
        print(f"New importance: {new_imp}")
    elif args.command == "decay":
        count = decay_importance(args.days)
        print(f"Decayed {count} entries")
    else:
        parser.print_help()
