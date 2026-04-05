# agents-memory Changelog

## [1.0.7] - 2026-04-05

### Added
- **Collection priority scoring** - Results weighted by collection importance (critical > core > plan > spec > important > tasks > casual)
- **Recency boost** - Recent entries get slight boost in search ranking
- **LRU cache** - Handler.js caches search results (100 entries, 30s TTL)
- **Query optimization** - Stopword removal + 200 char truncation
- **Persistent socket connection** - Handler reuses socket instead of connect/disconnect per request
- **HNSW tuning** - ef_search=200, ef_construction=200, m=48 in settings.yaml
- **Cache statistics logging** - Track cache hits/misses

### Changed
- **Scoring formula** - similarity + collection_priority + importance_boost + recency_boost
- **Single collection search** - Direct call (no ThreadPool overhead)
- **Config structure** - Added `search` and `hnsw` sections to settings.yaml

## [1.0.6] - 2026-04-05

### Added
- **plan and spec collections** - For project plans and specifications
- **Collection filter** - `search_memory(collection="tasks")` to search single collection

### Fixed
- Collection filter not working in daemon search handler

## [1.0.5] - 2026-04-04

### Added
- `memory_gc.py` - Garbage collection with dedup, decay, trash
- Systemd timers for automatic weekly/monthly cleanup
- MIT LICENSE file

### Changed
- Cleanup repo - ignore internal docs from git/npm publish

## [1.0.4] - 2026-04-04

### Added
- agents-memory daemon with UNIX socket
- Parallel search across collections
- Socket-based IPC between hook and daemon

## [1.0.0] - 2026-04-03

### Added
- Initial release
- ChromaDB integration with sentence-transformers
- Pre-LLM and Post-LLM hooks for OpenClaw
- Skill scripts: search, write, bootstrap, pre_llm, post_llm, gc
