#!/usr/bin/env python3
"""
memory_daemon.py - Persistent daemon for fast semantic memory
Usage: python3 memory_daemon.py [--daemon]

Runs a Unix socket daemon that keeps the embedding model loaded in memory.
Clients connect via socket to send search/write/stats commands without model reload overhead.

Optimizations:
- Embedding cache for repeated queries
- Query result cache (LRU)
- Connection keep-alive
"""

import sys
import os
import json
import socket
import signal
import time
import hashlib
import logging
from pathlib import Path
from collections import OrderedDict

sys.path.insert(0, str(Path(__file__).parent))

from chroma_client import (
    get_chroma_client, get_embedding_function, search_memory,
    get_all_collections, get_settings, expand_path, COLLECTIONS
)
from logger import get_logger

# Production mode: set AGENTS_MEMORY_PRODUCTION=1 to suppress debug/info logs
PRODUCTION = os.environ.get("AGENTS_MEMORY_PRODUCTION", "").lower() in ("1", "true", "yes")

log = get_logger("memory-daemon")

# Suppress debug logs in production mode
if PRODUCTION:
    log.setLevel(logging.WARNING)

RUNTIME_DIR = os.environ.get("AGENTS_MEMORY_RUNTIME_DIR", os.path.join(os.environ.get("HOME", "/home/" + os.environ.get("USER", "developer")), ".memory", "agents-memory"))
PID_FILE = os.path.join(RUNTIME_DIR, "daemon.pid")
SOCKET_FILE = os.path.join(RUNTIME_DIR, "daemon.sock")

CONNECTION_TIMEOUT = 10  # seconds

# Embedding cache (LRU cache for computed query embeddings)
EMBEDDING_CACHE_MAX = 500
EMBEDDING_CACHE_TTL = 300  # 5 minutes
embedding_cache = OrderedDict()

# Query result cache (LRU cache for search results)
QUERY_CACHE_MAX = 200
QUERY_CACHE_TTL = 300  # 5 minutes
query_cache = OrderedDict()

# Metrics tracking
METRICS = {
    "searches": 0,           # Total search calls
    "searches_with_results": 0,  # Searches that returned results
    "writes": 0,             # Total write calls
    "writes_rejected": 0,     # Writes rejected (quality check, dedup)
    "writes_updated": 0,     # Writes that updated existing entries
    "cache_hits": 0,         # Cache hits
    "cache_misses": 0,       # Cache misses
    "projects": set(),       # Unique projects seen
}

# Current project context (can be set by client)
CURRENT_PROJECT = "default"


def cleanup():
    """Remove stale socket and PID files."""
    for f in [SOCKET_FILE, PID_FILE]:
        try:
            os.unlink(f)
        except OSError:
            pass


def signal_handler(sig, frame):
    log.info("Received signal %s, shutting down", sig)
    cleanup()
    sys.exit(0)


def reload_handler(sig, frame):
    """SIGHUP handler: flush caches and reload (graceful reload without restart)."""
    global query_cache, METRICS
    
    log.info("Received SIGHUP, flushing caches...")
    
    # Flush query cache
    flushed = len(query_cache)
    query_cache.clear()
    
    # Optionally reset metrics (uncomment to reset on SIGHUP)
    # METRICS = {"searches": 0, "searches_with_results": 0, "writes": 0,
    #            "writes_rejected": 0, "writes_updated": 0,
    #            "cache_hits": 0, "cache_misses": 0, "projects": set()}
    
    log.info(f"Caches flushed ({flushed} entries cleared)")


def daemonize():
    """Fork into background daemon."""
    if os.fork() > 0:
        sys.exit(0)

    os.setsid()
    os.chdir("/")

    devnull = os.open("/dev/null", os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    if devnull > 2:
        os.close(devnull)

    os.makedirs(os.path.dirname(PID_FILE), exist_ok=True)
    with open(PID_FILE, 'w') as f:
        f.write(str(os.getpid()))


def load_model():
    """Load embedding model once at daemon startup."""
    log.info("Loading embedding model...")
    get_chroma_client()
    get_embedding_function()
    log.info("Model ready — daemon accepting connections")


def get_cache_key(prefix: str, **kwargs) -> str:
    """Generate cache key from arguments."""
    # Sort keys for consistent ordering
    key_parts = [prefix] + [f"{k}={kwargs[k]}" for k in sorted(kwargs.keys()) if kwargs[k] is not None]
    return hashlib.md5("|".join(key_parts).encode()).hexdigest()


def get_cached_query(query: str, collection: str, limit: int) -> list:
    """Get cached query results if available and not expired."""
    key = get_cache_key("q", query=query, collection=collection, limit=limit)
    
    if key in query_cache:
        cached_time, cached_result = query_cache[key]
        if time.time() - cached_time < QUERY_CACHE_TTL:
            # Move to end (most recently used)
            query_cache.move_to_end(key)
            log.debug(f"Query cache hit: {query[:30]}...")
            return cached_result
        else:
            del query_cache[key]
    
    return None


def set_cached_query(query: str, collection: str, limit: int, result: list):
    """Cache query results with LRU eviction."""
    key = get_cache_key("q", query=query, collection=collection, limit=limit)
    
    # Evict oldest if at capacity
    if len(query_cache) >= QUERY_CACHE_MAX:
        query_cache.popitem(last=False)
    
    query_cache[key] = (time.time(), result)


def update_retrieval_metadata(results):
    """Update retrieval metadata for search results (feedback loop).
    
    This tracks which entries are retrieved and boosts their retrieval_count.
    Frequent retrieval = useful entry = higher score in future.
    """
    from datetime import datetime
    import threading
    
    def _update():
        try:
            client = get_chroma_client()
            ef = get_embedding_function()
            
            for entry in results:
                entry_id = entry.get("id")
                collection_name = entry.get("collection")
                if not entry_id or not collection_name:
                    continue
                
                try:
                    col = client.get_collection(name=collection_name, embedding_function=ef)
                    # Get current metadata
                    existing = col.get(ids=[entry_id])
                    meta = existing.get("metadatas", [{}])[0] if existing.get("metadatas") else {}
                except Exception:
                    continue
                
                # Update retrieval stats
                retrieval_count = meta.get("retrieval_count", 0) + 1
                meta["retrieval_count"] = retrieval_count
                meta["last_retrieved"] = datetime.now().isoformat()
                
                try:
                    # Update in Chroma
                    col.update(
                        ids=[entry_id],
                        metadatas=[meta]
                    )
                except Exception:
                    pass  # Non-blocking update
        except Exception:
            pass  # Non-blocking
    
    # Run in background thread (non-blocking)
    try:
        thread = threading.Thread(target=_update, daemon=True)
        thread.start()
    except Exception:
        pass  # Non-critical if threading fails


def handle_search(args):
    """Search memory using shared search_memory function with caching."""
    global METRICS, CURRENT_PROJECT
    
    query = args.get("query", "")
    project = args.get("project") or CURRENT_PROJECT
    entry_type = args.get("entry_type")
    limit = args.get("limit", 5)
    collection = args.get("collection")
    
    METRICS["searches"] += 1
    
    # Check cache first
    cached = get_cached_query(query, collection, limit)
    if cached is not None:
        METRICS["cache_hits"] += 1
        if cached:
            METRICS["searches_with_results"] += 1
            # Still track retrievals from cache (async, non-blocking)
            update_retrieval_metadata(cached)
        return {"data": cached, "cached": True}
    
    METRICS["cache_misses"] += 1
    
    # Execute search
    results = search_memory(
        query=query,
        project=project,
        entry_type=entry_type,
        limit=limit,
        collection=collection
    )
    
    # Track metrics
    if results:
        METRICS["searches_with_results"] += 1
    
    # Cache results
    set_cached_query(query, collection, limit, results)
    
    return {"data": results, "cached": False}


def handle_write(args):
    """Write new entry to memory."""
    global METRICS, CURRENT_PROJECT
    import uuid
    from datetime import datetime

    client = get_chroma_client()
    ef = get_embedding_function()

    problem = args.get("problem", "")
    solution = args.get("solution", "")
    project = args.get("project") or CURRENT_PROJECT
    entry_type = args.get("entry_type", args.get("type", "chat"))
    importance = args.get("importance", 0.5)

    METRICS["writes"] += 1
    METRICS["projects"].add(project)

    # Basic validation
    if not problem or not problem.strip():
        METRICS["writes_rejected"] += 1
        raise ValueError("problem must not be empty")

    content_parts = [f"Problem: {problem}"]
    if solution:
        content_parts.append(f"Solution: {solution}")
    content = "\n\n".join(content_parts)

    metadata = {
        "project": project,
        "entry_type": entry_type,
        "use_count": 0,
        "last_used": datetime.now().isoformat(),
        "importance": max(0.0, min(1.0, float(importance))),
        "language": "unknown",
        "retrieval_count": 0
    }

    type_to_collection = {
        "solution": "tasks", "skill": "tasks", "fact": "important",
        "decision": "progress", "baseline": "core", "chat": "casual",
        "prompt": "prompts", "critical": "critical", "law": "laws"
    }
    collection_name = type_to_collection.get(entry_type, "casual")

    collection = client.get_or_create_collection(name=collection_name, embedding_function=ef)
    entry_id = str(uuid.uuid4())
    collection.add(ids=[entry_id], documents=[content], metadatas=[metadata])

    log.info("Stored entry %s in %s", entry_id[:8], collection_name)
    return {"id": entry_id, "collection": collection_name, "status": "stored"}


def handle_batch_write(args):
    """Write multiple entries to memory in one call.
    
    Args:
        entries: list of {
            problem: str,
            solution: str (optional),
            project: str (optional),
            entry_type: str (optional),
            importance: float (optional)
        }
    """
    global METRICS
    import uuid
    from datetime import datetime

    entries = args.get("entries", [])
    if not entries:
        return {"results": [], "status": "no_entries"}

    client = get_chroma_client()
    ef = get_embedding_function()

    type_to_collection = {
        "solution": "tasks", "skill": "tasks", "fact": "important",
        "decision": "progress", "baseline": "core", "chat": "casual",
        "prompt": "prompts", "critical": "critical"
    }

    results = []
    for entry in entries:
        METRICS["writes"] += 1
        
        problem = entry.get("problem", "")
        if not problem or not problem.strip():
            METRICS["writes_rejected"] += 1
            results.append({"status": "rejected", "reason": "empty problem"})
            continue
        
        solution = entry.get("solution", "")
        project = entry.get("project") or CURRENT_PROJECT
        entry_type = entry.get("entry_type", "chat")
        importance = entry.get("importance", 0.5)
        
        METRICS["projects"].add(project)
        
        content_parts = [f"Problem: {problem}"]
        if solution:
            content_parts.append(f"Solution: {solution}")
        content = "\n\n".join(content_parts)
        
        metadata = {
            "project": project,
            "entry_type": entry_type,
            "use_count": 0,
            "last_used": datetime.now().isoformat(),
            "importance": max(0.0, min(1.0, float(importance))),
            "language": "unknown",
            "retrieval_count": 0
        }
        
        collection_name = type_to_collection.get(entry_type, "casual")
        collection = client.get_or_create_collection(name=collection_name, embedding_function=ef)
        entry_id = str(uuid.uuid4())
        collection.add(ids=[entry_id], documents=[content], metadatas=[metadata])
        results.append({"id": entry_id, "collection": collection_name, "status": "stored"})
    
    log.info("Batch wrote %d entries", len(results))
    return {"results": results, "total": len(results)}


def handle_stats(args):
    """Return memory statistics across all collections + cache + metrics stats."""
    global METRICS, CURRENT_PROJECT
    client = get_chroma_client()
    ef = get_embedding_function()

    stats = {}
    total = 0
    for col_name in COLLECTIONS:
        try:
            collection = client.get_collection(name=col_name, embedding_function=ef)
            count = collection.count()
            stats[col_name] = count
            total += count
        except Exception:
            stats[col_name] = 0

    stats["_total"] = total
    
    # Add cache statistics
    cache_hit_rate = 0
    total_cache_ops = METRICS["cache_hits"] + METRICS["cache_misses"]
    if total_cache_ops > 0:
        cache_hit_rate = METRICS["cache_hits"] / total_cache_ops
    
    stats["_cache"] = {
        "query_cache_size": len(query_cache),
        "query_cache_max": QUERY_CACHE_MAX,
        "query_cache_ttl": QUERY_CACHE_TTL,
        "hits": METRICS["cache_hits"],
        "misses": METRICS["cache_misses"],
        "hit_rate": round(cache_hit_rate, 3)
    }
    
    # Add metrics
    search_hit_rate = 0
    if METRICS["searches"] > 0:
        search_hit_rate = METRICS["searches_with_results"] / METRICS["searches"]
    
    stats["_metrics"] = {
        "searches": METRICS["searches"],
        "searches_with_results": METRICS["searches_with_results"],
        "search_hit_rate": round(search_hit_rate, 3),
        "writes": METRICS["writes"],
        "writes_rejected": METRICS["writes_rejected"],
        "writes_updated": METRICS["writes_updated"],
        "unique_projects": len(METRICS["projects"]),
        "current_project": CURRENT_PROJECT
    }
    
    return stats


def handle_set_project(args):
    """Set the current project context for searches and writes."""
    global CURRENT_PROJECT
    project = args.get("project", "default")
    CURRENT_PROJECT = project
    METRICS["projects"].add(project)
    return {"project": CURRENT_PROJECT, "status": "set"}


def handle_reset_metrics(args):
    """Reset metrics counters."""
    global METRICS
    METRICS = {
        "searches": 0,
        "searches_with_results": 0,
        "writes": 0,
        "writes_rejected": 0,
        "writes_updated": 0,
        "cache_hits": 0,
        "cache_misses": 0,
        "projects": METRICS.get("projects", set()),
    }
    return {"status": "metrics_reset"}


def handle_client(conn):
    """Handle a single client connection with timeout."""
    try:
        conn.settimeout(CONNECTION_TIMEOUT)

        # Read full message
        data = b""
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk
            try:
                json.loads(data.decode())
                break
            except json.JSONDecodeError:
                continue

        if not data:
            conn.close()
            return

        msg = json.loads(data.decode())
        cmd = msg.get("cmd")
        args = msg.get("args", {})

        try:
            if cmd == "search":
                result = {"ok": True, "data": handle_search(args)}
            elif cmd == "write":
                result = {"ok": True, "data": handle_write(args)}
            elif cmd == "batch_write":
                result = {"ok": True, "data": handle_batch_write(args)}
            elif cmd == "stats":
                result = {"ok": True, "data": handle_stats(args)}
            elif cmd == "set_project":
                result = {"ok": True, "data": handle_set_project(args)}
            elif cmd == "reset_metrics":
                result = {"ok": True, "data": handle_reset_metrics(args)}
            elif cmd == "ping":
                result = {"ok": True, "data": "pong"}
            else:
                result = {"ok": False, "error": f"Unknown command: {cmd}"}
        except Exception as e:
            log.error("Command '%s' failed: %s", cmd, e)
            result = {"ok": False, "error": str(e)}

        conn.sendall((json.dumps(result, default=str) + "\n").encode())
    except socket.timeout:
        try:
            conn.sendall((json.dumps({"ok": False, "error": "timeout"}) + "\n").encode())
        except Exception:
            pass
    except Exception as e:
        try:
            conn.sendall((json.dumps({"ok": False, "error": str(e)}) + "\n").encode())
        except Exception:
            pass
    finally:
        conn.close()


def run_daemon():
    """Start the daemon process."""
    # Check if already running
    if os.path.exists(SOCKET_FILE):
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.connect(SOCKET_FILE)
            sock.sendall(json.dumps({"cmd": "ping"}).encode())
            resp = sock.recv(1024)
            if resp:
                print("Daemon already running", file=sys.stderr)
                return True
        except Exception:
            pass

    cleanup()
    daemonize()

    # Load model after daemonizing
    load_model()

    os.makedirs(os.path.dirname(SOCKET_FILE), exist_ok=True)

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(SOCKET_FILE)
    sock.listen(5)
    os.chmod(SOCKET_FILE, 0o600)

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGHUP, reload_handler)

    # Accept loop
    while True:
        try:
            conn, _ = sock.accept()
            handle_client(conn)
        except Exception:
            pass


def run_client():
    """Connect to running daemon as a client."""
    if not os.path.exists(SOCKET_FILE):
        print("Daemon not running. Starting...", file=sys.stderr)
        run_daemon()
        time.sleep(2)

    for i in range(3):
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.connect(SOCKET_FILE)

            cmd = sys.argv[1] if len(sys.argv) > 1 else "ping"
            args = {}
            if len(sys.argv) > 2:
                args = json.loads(sys.argv[2])

            sock.sendall(json.dumps({"cmd": cmd, "args": args}).encode())
            resp = b""
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                resp += chunk
                if b"\n" in resp:
                    break

            if resp:
                sys.stdout.write(resp.decode())
                sys.stdout.flush()
            sock.close()
            return
        except Exception as e:
            if i < 2:
                time.sleep(1)
                continue
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--daemon":
        run_daemon()
    else:
        run_client()
