/**
 * agents-memory Managed Hook (CommonJS)
 * Events: message:preprocessed, message:sent, session:compact:after
 *
 * message:preprocessed - Fires BEFORE AI responds. Used to:
 *   - Set pending user message (waiting for AI response)
 *   - Check if previous pending has AI response → save paired
 *   - Clean up stale pending (>2 min without AI response)
 *
 * message:sent - Fires AFTER AI sends response. Used to:
 *   - Save AI response to working collection
 *   - Pair with pending user message
 *   - Save to appropriate collection based on user message
 *
 * OpenClaw Event Structure:
 * - message:preprocessed:
 *   - event.context.bodyForAgent = clean user message
 *   - event.context.sessionKey = session identifier
 * - message:sent:
 *   - event.context.content = AI response content
 *   - event.context.sessionKey = session identifier
 */

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const crypto = require("crypto");

const SOCKET = process.env.HOME + "/.memory/agents-memory/daemon.sock";
const MEMORY_DIR = process.env.HOME + "/.memory/agents-memory";
const SESSIONS_DIR = path.join(os.homedir(), ".openclaw", "agents", "main", "sessions");

// Cache configuration
const CACHE_TTL = 300000;  // 5 minutes (300s)
const CACHE_MAX = 100;
const MAX_INJECT_CHARS = 5000;

// Simple in-memory cache for query results (LRU with TTL)
const cache = new Map();

// Compaction configuration
const COMPACTION_THRESHOLD = 5; // Trigger after 5 messages per session
const COMPACTION_KEYWORD = "MEMORY CONSOLIDATED";

// Determine which collection to save to based on content
// Map hook collection names to daemon type names
const COLLECTION_MAP = {
    "tasks": "solution",    // problem→solution → tasks collection
    "progress": "summary",  // completed work → progress collection
    "plan": "decision",     // goals/roadmap → progress collection (stored as decision type)
    "working": "working",    // AI responses → working collection
    "prompts": "prompt",     // user messages → prompts collection
    "important": "fact",     // important facts → important collection
    "core": "baseline",     // core baselines → core collection
    "critical": "critical"   // time-sensitive → critical collection
};

// Determine which collection to save to based on message content
// Both user prompt AND AI response go to the SAME collection
function determineCollection(userMsg, aiResponse) {
    const text = (userMsg + " " + (aiResponse || "")).toLowerCase();

    // laws (highest priority - explicit user instruction)
    const lawsPatterns = [
        /make this (a |your )?(rule|guideline|workflow|law)/i,
        /this is a (rule|guideline|law|principle)/i,
        /always (do|must|should)/i,
        /never (do|must|should)/i,
        /this (should|must) be (done|followed)/i
    ];

    // Progress indicators
    const progressPatterns = [
        /done|completed|finished|fixed|solved/i,
        /just did|already|success|working now/i,
        /its working|i got it|i fixed/i,
        /updated|changed|modified|improved/i
    ];

    // Plan indicators
    const planPatterns = [
        /will|going to|plan to|intend/i,
        /next step|next phase|roadmap/i,
        /should do|need to|must do|will do/i,
        /tomorrow|later|eventually/i
    ];

    // Important facts
    const importantPatterns = [
        /remember|important|preference/i,
        /don't forget|note that|keep in mind/i,
        /my (name|preference|setting|config)/i
    ];

    // Core (baseline architecture/decisions)
    const corePatterns = [
        /architecture|project structure|tech stack/i,
        /baseline|core (decision|knowledge|rule)/i,
        /this is (how|the way) we (do|build)/i
    ];

    // Tasks (questions/how-to)
    const taskPatterns = [
        /how (to|do)|what (is|are|do)|why (is|does|did)/i,
        /help me|explain|learn|i need|i want/i,
        /can you|could you|would you|please/i,
        /fix|debug|test|check|verify|implement/i,
        /create|build|make|develop|setup/i
    ];

    // Casual
    const casualPatterns = [
        /^hi|^hey|^hello|^thanks|^ok|^yes|^no/i,
        /^(ok|okay|good|nice|yeah)/i,
        /^sure|^fine|^cool/i
    ];

    // Check in priority order
    for (const pattern of lawsPatterns) {
        if (pattern.test(text)) return "laws";
    }

    for (const pattern of progressPatterns) {
        if (pattern.test(text)) return "progress";
    }

    for (const pattern of planPatterns) {
        if (pattern.test(text)) return "plan";
    }

    for (const pattern of importantPatterns) {
        if (pattern.test(text)) return "important";
    }

    for (const pattern of corePatterns) {
        if (pattern.test(text)) return "core";
    }

    for (const pattern of taskPatterns) {
        if (pattern.test(text)) return "tasks";
    }

    for (const pattern of casualPatterns) {
        if (pattern.test(text)) return "casual";
    }

    return "prompts"; // Default - user's prompts/questions
}

// Session tracking
let conversationHistory = [];
let messageCountSinceCompact = 0;

// Pending messages: store user message until AI responds, then pair them
// Structure: sessionKey -> { userMsg, timestamp, saved: boolean }
// Persisted to file so systemd timer can also check for stale entries
const PENDING_FILE = path.join(os.homedir(), ".memory", "agents-memory", "pending.json");
const pendingUserMessages = new Map();

// Load pending from file on startup
function loadPendingFromFile() {
    try {
        if (fs.existsSync(PENDING_FILE)) {
            const data = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
            for (const [key, value] of Object.entries(data)) {
                pendingUserMessages.set(key, value);
            }
            console.log("[agents-memory] Loaded", pendingUserMessages.size, "pending from file");
        }
    } catch (e) {
        console.warn("[agents-memory] Failed to load pending from file:", e.message);
    }
}

// Save pending to file
function savePendingToFile() {
    try {
        const obj = Object.fromEntries(pendingUserMessages);
        fs.writeFileSync(PENDING_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {
        console.warn("[agents-memory] Failed to save pending to file:", e.message);
    }
}

// Initialize - load pending on module load
loadPendingFromFile();

// Get session key (session ID or fallback)
function getSessionKey(event) {
    // Try multiple sources for session key
    const sessionKey = event?.context?.sessionKey
        || event?.context?.sessionId
        || event?.sessionKey
        || event?.sessionId;

    // If still undefined, use a fallback
    if (!sessionKey) {
        // Try to get from senderId + timestamp as fallback
        const senderId = event?.context?.senderId || event?.senderId || 'unknown';
        const msgId = event?.context?.messageId || event?.messageId || Date.now().toString();
        return `session:${senderId}:${msgId}`;
    }

    return sessionKey;
}

function getMessageBody(event) {
    // OpenClaw message:preprocessed event structure:
    // - event.context.bodyForAgent = clean user message
    // - event.context.body = raw message (may include prefix)
    // - event.messages = array of conversation messages (user + assistant) - usually EMPTY!

    // Priority 1: event.context.bodyForAgent (clean message)
    if (event.context && event.context.bodyForAgent) {
        console.log("[agents-memory] DEBUG: Using event.context.bodyForAgent");
        return event.context.bodyForAgent;
    }

    // Priority 2: event.context.body (raw message)
    if (event.context && event.context.body) {
        console.log("[agents-memory] DEBUG: Using event.context.body");
        return event.context.body;
    }

    const messages = event.messages || [];

    // Debug: log what we have
    if (messages.length === 0) {
        console.log("[agents-memory] DEBUG: No messages in event");
        console.log("[agents-memory] DEBUG: Available keys:", Object.keys(event).join(", "));
        console.log("[agents-memory] DEBUG: event.context keys:", event.context ? Object.keys(event.context).join(", ") : "null");

        // Try other fallbacks
        if (event.content) {
            console.log("[agents-memory] DEBUG: Using event.content");
            return typeof event.content === "string" ? event.content : JSON.stringify(event.content);
        }
        if (event.text) {
            console.log("[agents-memory] DEBUG: Using event.text");
            return event.text;
        }
        if (event.raw) {
            console.log("[agents-memory] DEBUG: Using event.raw");
            return typeof event.raw === "string" ? event.raw : JSON.stringify(event.raw);
        }
        if (event.context && event.context.lastMessage) {
            console.log("[agents-memory] DEBUG: Using event.context.lastMessage");
            return event.context.lastMessage;
        }
        return "";
    }

    // Get last user message (not assistant)
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i] && messages[i].role === "user") {
            const content = messages[i].content;
            if (typeof content === "string") {
                return content;
            }
            if (Array.isArray(content)) {
                // Content might be array of blocks
                for (const block of content) {
                    if (block.type === "text" && block.text) {
                        return block.text;
                    }
                }
            }
            return JSON.stringify(content);
        }
    }

    // Fallback: return last message content
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.content) {
        return typeof lastMsg.content === "string" ? lastMsg.content : JSON.stringify(lastMsg.content);
    }

    return "";
}

function isCommand(msg) {
    const cmdPatterns = [
        /^(\/reset|\/new|\/clear|help|\?\s*$)/i,
        /^(\/\/code|\/run|test|build|deploy)/i
    ];
    return cmdPatterns.some(p => p.test(msg));
}

function shouldSaveToMemory(msg) {
    // Keywords that indicate user wants to save response
    const savePatterns = [
        /remember\s+this/i,
        /save\s+to\s+memory/i,
        /keep\s+this/i,
        /store\s+this/i,
        /don't\s+forget/i,
        /save\s+this/i,
        /remember\s+me/i
    ];
    return savePatterns.some(p => p.test(msg));
}


function aiIndicatedSave(content) {
    // Check if AI indicated it saved to memory
    const savePatterns = [
        /\[memory\s*saved\]/i,
        /memory\s*consolidated/i,
        /saved\s+to\s+memory/i,
        /stored\s+in\s+working/i,
        /progress\s*updated/i,
        /memory\s*updated/i
    ];
    return savePatterns.some(p => p.test(content));
}

function getLastAssistantResponseFromSession(sessionKey, maxLines = 50) {
    const sessionsFile = path.join(SESSIONS_DIR, "sessions.json");
    try {
        const data = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
        const sessionEntry = data[sessionKey];
        if (!sessionEntry || !sessionEntry.sessionFile) return null;

        const sessionFile = sessionEntry.sessionFile;
        const lines = [];
        const stream = fs.createReadStream(sessionFile, { encoding: "utf8", limit: 2 * 1024 * 1024 });

        return new Promise((resolve) => {
            let buffer = "";
            stream.on("data", (chunk) => {
                buffer += chunk;
                const parts = buffer.split("\n");
                buffer = parts.pop();
                for (const line of parts) {
                    try {
                        const obj = JSON.parse(line);
                        if (obj.message && obj.message.role === "assistant") {
                            const content = obj.message.content;
                            if (Array.isArray(content)) {
                                for (const block of content) {
                                    if (block.type === "text" && block.text) {
                                        lines.push(block.text);
                                    }
                                }
                            }
                        }
                    } catch (e) {}
                }
            });
            stream.on("end", () => resolve(lines.slice(-maxLines).join("\n")));
            stream.on("error", () => resolve(null));
        });
    } catch (e) {
        return Promise.resolve(null);
    }
}

// Get all recent AI responses from session file as an array
function getRecentAIResponses(sessionKey, maxResponses = 20) {
    const sessionsFile = path.join(SESSIONS_DIR, "sessions.json");
    try {
        const data = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
        const sessionEntry = data[sessionKey];
        if (!sessionEntry || !sessionEntry.sessionFile) return [];

        const sessionFile = sessionEntry.sessionFile;
        const responses = [];
        const buffer = fs.readFileSync(sessionFile, "utf8");
        const lines = buffer.split("\n");
        
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const obj = JSON.parse(line);
                if (obj.message && obj.message.role === "assistant") {
                    const content = obj.message.content;
                    if (Array.isArray(content)) {
                        for (const block of content) {
                            if (block.type === "text" && block.text) {
                                responses.push(block.text);
                            }
                        }
                    } else if (typeof content === "string") {
                        responses.push(content);
                    }
                }
            } catch (e) {}
        }
        
        return responses.slice(-maxResponses);
    } catch (e) {
        console.log("[agents-memory] getRecentAIResponses error:", e.message);
        return [];
    }
}

// Sync version - reads last assistant message content synchronously
function getLastAssistantMessageSync(sessionKey) {
    if (!sessionKey || sessionKey === 'undefined') {
        console.log("[agents-memory] Warning: sessionKey is undefined, skipping AI response capture");
        return null;
    }

    const sessionsFile = path.join(SESSIONS_DIR, "sessions.json");
    try {
        const data = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
        const sessionEntry = data[sessionKey];
        if (!sessionEntry || !sessionEntry.sessionFile) {
            console.log("[agents-memory] Warning: session not found for key", sessionKey);
            return null;
        }

        const sessionFilePath = sessionEntry.sessionFile;
        if (!fs.existsSync(sessionFilePath)) {
            console.log("[agents-memory] Warning: session file not found", sessionFilePath);
            return null;
        }

        const lines = fs.readFileSync(sessionFilePath, "utf8").split("\n").filter(l => l.trim());

        // Read from end to find last assistant message
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const obj = JSON.parse(lines[i]);
                if (obj.message && obj.message.role === "assistant") {
                    const msgContent = obj.message.content;
                    if (typeof msgContent === "string" && msgContent.trim()) {
                        console.log("[agents-memory] Found AI response:", msgContent.slice(0, 50) + "...");
                        return msgContent.trim();
                    } else if (Array.isArray(msgContent)) {
                        for (const block of msgContent) {
                            if (block.type === "text" && block.text) {
                                console.log("[agents-memory] Found AI response (block):", block.text.slice(0, 50) + "...");
                                return block.text.trim();
                            }
                        }
                    }
                }
            } catch (e) {}
        }
        console.log("[agents-memory] No AI response found in session");
        return null;
    } catch (e) {
        console.log("[agents-memory] Error reading session:", e.message);
        return null;
    }
}

function daemonCall(cmd, args = {}) {
    const client = net.createConnection({ path: SOCKET });
    const payload = JSON.stringify({ cmd, args });
    client.write(payload);

    const chunks = [];
    client.on("data", chunk => {
        chunks.push(chunk);
    });

    return new Promise((resolve, reject) => {
        client.on("end", () => {
            const response = Buffer.concat(chunks).toString();
            try {
                const data = JSON.parse(response);
                resolve(data);
            } catch (e) {
                reject(e);
            }
        });

        client.on("error", (err) => {
            reject(err);
        });

        // Timeout
        setTimeout(() => {
            client.destroy();
            reject(new Error("Socket timeout"));
        }, 10000);
    });
}

function getCacheKey(query, collection, limit) {
    return crypto.createHash('md5').update(`${query}:${collection}:${limit}`).digest('hex');
}

function getCached(key) {
    return cache.get(key);
}

function setCache(key, data) {
    // Evict oldest if at capacity
    if (cache.size >= CACHE_MAX) {
        let oldestKey = null;
        let oldestTs = Infinity;

        for (const [k, v] of cache) {
            if (v.ts < oldestTs) {
                oldestTs = v.ts;
                oldestKey = k;
            }
        }
        if (oldestKey) {
            cache.delete(oldestKey);
        }
    }

    const entry = {
        ts: Date.now(),
        data
    };
    cache.set(key, entry);
}

function extractTextContent(content) {
    if (!content) return null;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map(extractTextContent).filter(Boolean).join(" ");
    }
    if (content && content.type === "text") return content.text;
    return null;
}

function optimizeQuery(query) {
    return query
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 200);
}

function extractSnippet(result, query) {
    const content = result.content || result.metadata?.content || "";
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
        if (line.toLowerCase().includes(query.toLowerCase())) {
            return line.slice(0, 200);
        }
    }
    return content.slice(0, 150);
}

// Simple in-memory cache for compaction tracking
const sessionCompactionTracking = new Map(); // session_id -> { msgCount, lastCompactedMsgCount }

async function messageSent(event) {
    // message:sent fires AFTER AI sends a response
    // We can use this to immediately save AI response paired with pending user message
    
    try {
        const aiResponse = event.context?.content || event.context?.body || "";
        const sessionKey = event.context?.sessionKey || event.sessionKey || 'default';
        
        if (!aiResponse || aiResponse.length < 3) {
            return;
        }
        
        console.log("[agents-memory] message:sent - AI response:", aiResponse.slice(0, 30) + "...");
        
        // Check if there's a pending user message
        const pending = pendingUserMessages.get(sessionKey);
        
        if (pending && !pending.saved && pending.collection) {
            // We have a pending user message and its collection
            // Save AI response to WORKING and also to the determined collection
            
            // Save to working (AI response) — FULL, no truncation
            await daemonCall("write", {
                problem: pending.userMsg,
                solution: aiResponse,
                type: "working",
                metadata: { session_id: sessionKey, role: "ai_response" }
            });
            console.log("[agents-memory] Saved AI response to working (full, no truncation)");
            
            // Also save to the pending collection (user's question + AI response) — FULL
            const type = COLLECTION_MAP[pending.collection] || pending.collection;
            await daemonCall("write", {
                problem: pending.userMsg,
                solution: aiResponse,
                type: type,
                metadata: { session_id: sessionKey, role: "paired", original_collection: pending.collection }
            });
            console.log("[agents-memory] Saved paired to", pending.collection);
            
            // Mark pending as saved
            pending.saved = true;
            pendingUserMessages.delete(sessionKey);
            savePendingToFile();
        }
    } catch (e) {
        console.warn("[agents-memory] message:sent error:", e.message);
    }
}

// ───────────────────────────────────────────────────────
// PRE-LLM: Query memory + track conversation
// ───────────────────────────────────────────────────────
async function messagePreprocessed(event) {
    const rawMsg = getMessageBody(event);
    console.log("[agents-memory] rawMsg:", rawMsg ? rawMsg.slice(0,30) : "null/undefined", "length:", rawMsg ? rawMsg.length : "N/A");
    // Debug event structure
    if (!rawMsg) {
        console.log("[agents-memory] DEBUG event.messages:", JSON.stringify(event.messages || []).slice(0, 200));
        console.log("[agents-memory] DEBUG event.context:", JSON.stringify(event.context || {}).slice(0, 300));
        console.log("[agents-memory] DEBUG event keys:", Object.keys(event).join(", "));
    }
    if (!rawMsg || rawMsg.length < 3) return;

    // ───────────────────────────────────────────────────────
    // Handle /memory compact command
    // ───────────────────────────────────────────────────────
    if (/^\/memory\s*compact/i.test(rawMsg)) {
        console.log("[agents-memory] Detected /memory compact command");
        event.messages.push({
            role: "system",
            content: `[MEMORY COMPACT] User requested memory consolidation.

Your task:
1. Review the recent conversation history
2. Create a summary of key points, decisions, and learnings
3. Save to memory using exec:
   exec: ~/.npm-global/bin/agents-memory write "<summary title>" -s "<detailed summary of what was discussed, decided, and accomplished>" -t working

After saving, respond with "[memory compacted]"`
        });
        return; // Don't process as regular message
    }

    // Skip other commands for learning
    if (isCommand(rawMsg)) {
        console.log("[agents-memory] Skipping command - not learning material");
        return;
    }

    // Track conversation
    conversationHistory.push({ role: "user", content: rawMsg });
    messageCountSinceCompact++;

    const sessionKey = getSessionKey(event);

    // Get or create session tracking
    let sessionTracking = sessionCompactionTracking.get(sessionKey);
    if (!sessionTracking) {
        sessionTracking = { msgCount: 0, lastCompactedMsgCount: 0 };
        sessionCompactionTracking.set(sessionKey, sessionTracking);
    }

    try {
        const originalQuery = rawMsg.slice(0, 100);
        const query = optimizeQuery(rawMsg);
        const cacheKey = getCacheKey(query, 'multi', 5);

        // ───────────────────────────────────────────────────────
        // FLOW:
        // 1. Clean up STALE pending (no AI response after 2 min)
        // 2. Set current user message as PENDING (waiting for AI response)
        // 3. When AI responds, message:sent handler will pair and save
        // ───────────────────────────────────────────────────────
        
        const STALE_THRESHOLD_MS = 120000; // 2 minutes
        const now = Date.now();
        
        // ───────────────────────────────────────────────────────
        // 1. Clean up STALE pending (user didn't wait for AI response)
        // ───────────────────────────────────────────────────────
        for (const [key, p] of pendingUserMessages.entries()) {
            if (p.saved) continue;
            
            if (now - p.timestamp > STALE_THRESHOLD_MS) {
                // User left without AI response
                const staleCollection = determineCollection(p.userMsg, "");
                const staleType = COLLECTION_MAP[staleCollection] || staleCollection;
                await daemonCall("write", {
                    problem: p.userMsg,
                    solution: "(no AI response - user inactive)",
                    type: staleType,
                    metadata: { session_id: key, role: "stale", original_collection: staleCollection }
                });
                console.log("[agents-memory] Saved stale to", staleCollection);
                p.saved = true;
                pendingUserMessages.delete(key);
                savePendingToFile();
            }
        }
        
        // ───────────────────────────────────────────────────────
        // 2. Set current user message as PENDING (waiting for AI response)
        // ───────────────────────────────────────────────────────
        const currentCollection = determineCollection(rawMsg, "");
        pendingUserMessages.set(sessionKey, {
            userMsg: rawMsg,
            timestamp: now,
            saved: false,
            collection: currentCollection
        });
        savePendingToFile();
        console.log("[agents-memory] Pending set for", currentCollection, ":", rawMsg.slice(0, 30));
        
        // NOTE: We DON'T save here. message:sent will handle saving AI response.

        // ───────────────────────────────────────────────────────
        // Step 3: Check compaction threshold
        // ───────────────────────────────────────────────────────
        sessionTracking.msgCount++;

        if (sessionTracking.msgCount >= COMPACTION_THRESHOLD) {
            console.log("[agents-memory] Threshold reached:", sessionTracking.msgCount, "/", COMPACTION_THRESHOLD);
            await executeCompaction(sessionKey, event);
            sessionTracking.msgCount = 0;
        }

        // ───────────────────────────────────────────────────────
        // Step 4: LAWS — Always injected (unconditional)
        // ───────────────────────────────────────────────────────
        let injectedChars = 0;
        try {
            const lawsRes = await daemonCall("search", { query: "rules guidelines laws", collection: "laws", limit: 20 });
            const laws = lawsRes?.data?.data || [];
            if (laws.length > 0) {
                const lawText = laws.map(l => l.content || "").join("\n---\n").slice(0, 2000);
                event.messages.push({ role: "system", content: "LAWS (always follow):\n" + lawText });
                injectedChars += lawText.length;
            }
        } catch(e) {
            console.warn("[agents-memory] laws inject error:", e.message);
        }

        // ───────────────────────────────────────────────────────
        // Step 5: Semantic search across important collections
        // ───────────────────────────────────────────────────────
        const semanticCollections = ["working", "tasks", "progress", "core", "important"];
        const semanticResults = [];
        for (const col of semanticCollections) {
            try {
                const r = await daemonCall("search", { query, collection: col, limit: 2 });
                const items = r?.data?.data || [];
                items.forEach(item => { item._collection = col; semanticResults.push(item); });
            } catch(e) {}
        }
        // Sort by score descending
        semanticResults.sort((a, b) => (b.score || b.similarity || 0) - (a.score || a.similarity || 0));

        // Inject top results up to MAX_INJECT_CHARS
        if (semanticResults.length > 0) {
            const snippets = [];
            for (const r of semanticResults.slice(0, 5)) {
                const snippet = extractSnippet(r, rawMsg);
                if (injectedChars + snippet.length > MAX_INJECT_CHARS) break;
                snippets.push(`[${r._collection}] ${snippet}`);
                injectedChars += snippet.length;
            }
            if (snippets.length > 0) {
                event.messages.push({ role: "system", content: "Relevant context:\n" + snippets.join("\n") });
                console.log("[agents-memory] Injected", snippets.length, "semantic results");
            }
        } else {
            console.log("[agents-memory] No semantic results - still injecting auto-save");
        }

        // ───────────────────────────────────────────────────────
        // MANDATORY: Auto-save instruction via memory_save MCP tool
        // ───────────────────────────────────────────────────────
        const userMsgType = determineCollection(rawMsg, "");
        const autoSaveInstruction = `[MEM] After responding, call memory-save__memory_save(problem="${pending.userMsg}", solution="${aiResponse}", collection="${userMsgType}"). Required.`;
        event.messages.push({
            role: "system",
            content: autoSaveInstruction
        });
        console.log("[agents-memory] Injected auto-save instruction for collection:", userMsgType);
    } catch (e) {
        console.warn("[agents-memory] Error:", e.message);
    }
}

// ───────────────────────────────────────────────────────
// POST-LLM: Store learning after compaction
// ───────────────────────────────────────────────────────
async function sessionCompactAfter(event) {
    console.log("[agents-memory] Session compacted, checking for learnings...");

    const sessionKey = getSessionKey(event);

    // ───────────────────────────────────────────────────────
    // Get AI responses from session file
    // ───────────────────────────────────────────────────────
    const aiResponses = await getRecentAIResponses(sessionKey);
    console.log("[agents-memory] Found", aiResponses.length, "AI responses in session file");
    
    // ───────────────────────────────────────────────────────
    // Process pending user messages - pair with AI responses
    // ───────────────────────────────────────────────────────
    let savedCount = 0;
    for (const [key, pending] of pendingUserMessages.entries()) {
        if (pending.saved) continue;
        
        // User left or session ended - pair with AI response if available
        const aiResponse = aiResponses.length > 0 ? aiResponses[aiResponses.length - 1] : "(no AI response captured)";
        
        // Determine collection from pending (based on user message)
        const collection = pending.collection || "working";
        const type = COLLECTION_MAP[collection] || collection;
        
        // Save paired entry to the determined collection — FULL, no truncation
        await daemonCall("write", {
            problem: pending.userMsg,
            solution: aiResponse,
            type: type,
            metadata: { session_id: key, role: "paired_compact", original_collection: collection }
        });
        
        // Also save AI response to working — FULL, no truncation
        await daemonCall("write", {
            problem: pending.userMsg,
            solution: aiResponse,
            type: "working",
            metadata: { session_id: key, role: "ai_response_compact" }
        });
        
        console.log("[agents-memory] Compact: saved paired to", collection, "for session", key);
        savedCount++;
        
        // Mark as saved and remove
        pending.saved = true;
        pendingUserMessages.delete(key);
    }
    
    if (savedCount > 0) {
        savePendingToFile();
    }
    
    // ───────────────────────────────────────────────────────
    // Also save conversationHistory (user messages from this session)
    // ───────────────────────────────────────────────────────
    if (conversationHistory.length > 0) {
        console.log("[agents-memory] Storing", conversationHistory.length, "conversations to learning");
        for (let i = 0; i < conversationHistory.length; i++) {
            const entry = conversationHistory[i];
            await daemonCall("write", {
                problem: entry.content,
                solution: entry.content || "",
                type: "learning",
                project: event.context && event.context.project || null,
                metadata: { session_id: sessionKey }
            });
        }
    }

    // Reset for next session
    conversationHistory = [];
    messageCountSinceCompact = 0;

    // Reset compaction tracking
    const tracking = sessionCompactionTracking.get(sessionKey);
    if (tracking) {
        tracking.msgCount = 0;
        tracking.lastCompactedMsgCount = 0;
        sessionCompactionTracking.set(sessionKey, tracking);
    }
    
    console.log("[agents-memory] sessionCompactAfter complete, saved", savedCount, "pending entries");
}

// ───────────────────────────────────────────────────────
// Compaction: Summarize working collection and consolidate
// ───────────────────────────────────────────────────────
async function executeCompaction(sessionKey, event) {
    console.log("[agents-memory] Executing compaction for session:", sessionKey);

    const tracking = sessionCompactionTracking.get(sessionKey);
    if (!tracking) {
        console.log("[agents-memory] No tracking for session, skipping compaction");
        return;
    }

    const sessionMsgCount = tracking.msgCount;

    try {
        // ───────────────────────────────────────────────────────
        // Step 1: Get all messages for this session from working collection
        // ───────────────────────────────────────────────────────
        const workingResponse = await daemonCall("search", {
            query: "WORKING_SESSION_QUERY",
            collection: "working",
            limit: 100,
            filter: { session_id: sessionKey }
        });

        const allMessages = (workingResponse && workingResponse.data && workingResponse.data.data) || [];
        console.log("[agents-memory] Retrieved", allMessages.length, "messages from working collection");

        if (allMessages.length === 0) {
            console.log("[agents-memory] No messages to compact - skipping");
            return;
        }

        // ───────────────────────────────────────────────────────
        // Step 2: Delete old entries and insert summary prompt
        // ───────────────────────────────────────────────────────
        const allText = allMessages.map(m => m.content || "").join("\n\n");
        const summaryPrompt = `[MEMORY COMPACT] Consolidate ${allMessages.length} messages. Summary (max 500 chars): ` + allText.slice(0, 2000);

        console.log("[agents-memory] Injecting summary prompt for AI");
        if (event && event.messages) {
            event.messages.push({ role: "system", content: summaryPrompt });
        }

        await daemonCall("delete", {
            filter: { session_id: sessionKey },
            collection: "working"
        });

        console.log("[agents-memory] Compaction completed for session:", sessionKey);

        // Update tracking
        tracking.msgCount = 0;
        tracking.lastCompactedMsgCount = sessionMsgCount;
        sessionCompactionTracking.set(sessionKey, tracking);

    } catch (e) {
        console.error("[agents-memory] Compaction error:", e.message);
    }
}

// ───────────────────────────────────────────────────────
// DISPATCHER
// ───────────────────────────────────────────────────────
async function handler(event) {
    // Debug: dump full event structure (first call only)
    if (!globalThis._hookDebugDone) {
        globalThis._hookDebugDone = true;
        console.log("[agents-memory] FULL EVENT:", JSON.stringify(event).slice(0, 1000));
    }

    if (event && event.type) {
        console.log("[agents-memory] Received event type:", event.type, "action:", event.action);
    }

    const hook = event && event.type && event.action
        ? (event.type + ":" + event.action)
        : undefined;

    if (hook === "message:preprocessed") {
        return messagePreprocessed(event);
    } else if (hook === "message:sent") {
        return messageSent(event);
    } else if (hook === "session:compact:after") {
        return sessionCompactAfter(event);
    }
}

module.exports = handler;
module.exports.default = handler;
module.exports.messagePreprocessed = messagePreprocessed;
module.exports.messageSent = messageSent;
module.exports.sessionCompactAfter = sessionCompactAfter;
