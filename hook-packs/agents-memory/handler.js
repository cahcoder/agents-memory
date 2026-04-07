/**
 * agents-memory Managed Hook (CommonJS)
 * Events: message:preprocessed, session:compact:after
 *
 * Features:
 * - LRU cache with TTL
 * - Query optimization (truncation + stopword removal)
 * - Connection keep-alive
 * - LAWS collection (always injected)
 * - WORKING collection (tracks conversations, compaction trigger)
 *
 * OpenClaw Event Structure (message:preprocessed):
 * - event.messages = [] (EMPTY - dont use!)
 * - event.context.bodyForAgent = "[Mon 2026-04-06 21:48 GMT+7] message" (clean)
 * - event.context.body = "message" (raw)
 * - event.context.sessionKey = "agent:main:main"
 * - event.context.messageId = "uuid"
 * - event.context.senderId = "user-id"
 */

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");

const SOCKET = process.env.HOME + "/.memory/agents-memory/daemon.sock";
const MEMORY_DIR = process.env.HOME + "/.memory/agents-memory";
const SESSIONS_DIR = path.join(os.homedir(), ".openclaw", "agents", "main", "sessions");

// Cache configuration
const CACHE_TTL = 300000;  // 5 minutes (300s)
const CACHE_MAX = 100;
const MAX_INJECT_CHARS = 1500;

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

function getCacheKey(query, limit) {
    return `${query.slice(0, 100)}:${limit}`;
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
        const cacheKey = getCacheKey(query, 5);

        // ───────────────────────────────────────────────────────
        // FLOW:
        // 1. Check if there's PENDING user message that needs AI response paired
        // 2. Clean up STALE pending (no AI response after 2 min)
        // 3. Set new PENDING for current user message
        // 4. When AI responds later, it will be paired with this pending
        // ───────────────────────────────────────────────────────
        
        const STALE_THRESHOLD_MS = 120000; // 2 minutes
        const now = Date.now();
        
        // ───────────────────────────────────────────────────────
        // 1. Check for pending that needs pairing
        // ───────────────────────────────────────────────────────
        const lastAIResponse = getLastAssistantMessageSync(sessionKey);
        const pending = pendingUserMessages.get(sessionKey);
        
        if (pending && !pending.saved && lastAIResponse && lastAIResponse.length > 0) {
            // AI responded! Save PAIRED (user question + AI answer) to SAME collection
            // Determine collection based on user question, not AI response
            const pendingCollection = determineCollection(pending.userMsg, lastAIResponse);
            const pendingType = COLLECTION_MAP[pendingCollection] || pendingCollection;
            
            await daemonCall("write", {
                problem: pending.userMsg.slice(0, 200),
                solution: lastAIResponse.slice(0, 500),
                type: pendingType,
                metadata: { session_id: sessionKey, role: "paired", original_collection: pendingCollection }
            });
            console.log("[agents-memory] Saved paired to", pendingCollection, "(type:", pendingType + ")");
            
            pending.saved = true;
            pendingUserMessages.delete(sessionKey);
            savePendingToFile();
        }
        
        // ───────────────────────────────────────────────────────
        // 2. Clean up STALE pending (user didn't wait for AI response)
        // ───────────────────────────────────────────────────────
        for (const [key, p] of pendingUserMessages.entries()) {
            if (p.saved) continue;
            
            if (now - p.timestamp > STALE_THRESHOLD_MS) {
                // User left without AI response
                const staleCollection = determineCollection(p.userMsg, "");
                const staleType = COLLECTION_MAP[staleCollection] || staleCollection;
                await daemonCall("write", {
                    problem: p.userMsg.slice(0, 200),
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
        // 3. Set current user message as PENDING (waiting for AI response)
        // ───────────────────────────────────────────────────────
        const currentCollection = determineCollection(rawMsg, "");
        pendingUserMessages.set(sessionKey, {
            userMsg: rawMsg,
            timestamp: Date.now(),
            saved: false,
            collection: currentCollection
        });
        savePendingToFile();
        console.log("[agents-memory] Pending set for", currentCollection, ":", rawMsg.slice(0, 30));
        
        // NOTE: We DON'T save immediately here.
        // When AI responds, the NEXT user message will trigger the paired save.

        const workingResponse = await daemonCall("search", {
            query: query,
            collection: "working",
            limit: 3,
            filter: { session_id: sessionKey }
        });

        const workingResults = workingResponse && workingResponse.data && workingResponse.data.data || [];
        console.log("[agents-memory] Working:", workingResults.length, "entries");

        // ───────────────────────────────────────────────────────
        // Step 3: Check compaction threshold
        // ───────────────────────────────────────────────────────
        sessionTracking.msgCount++;

        if (sessionTracking.msgCount >= COMPACTION_THRESHOLD) {
            console.log("[agents-memory] Threshold reached:", sessionTracking.msgCount, "/", COMPACTION_THRESHOLD);
            event.messages.push({
                role: "system",
                content: `[memory: ${sessionTracking.msgCount} messages. Threshold: ${COMPACTION_THRESHOLD}.]`
            });
        }

        // ───────────────────────────────────────────────────────
        // Step 4: Combine results and inject
        // ───────────────────────────────────────────────────────
        const allResults = [...(lawsResults || []), ...(workingResults || [])];

        if (!allResults.length) {
            console.log("[agents-memory] No results - skipping injection");
            return;
        }

        const snippets = allResults.slice(0, 3).map(r => extractSnippet(r, rawMsg));

        let totalChars = 0;
        let contextParts = [];

        for (const snippet of snippets) {
            if (totalChars + snippet.length + 50 > MAX_INJECT_CHARS) break;
            contextParts.push(snippet);
            totalChars += snippet.length + 50;
        }

        if (contextParts.length) {
            event.messages.push({
                role: "system",
                content: "Relevant context:\n" + contextParts.join("\n")
            });
            console.log("[agents-memory] Injected", contextParts.length, "snippets");
        }
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

    // Need meaningful conversation (skip if only commands were said)
    if (conversationHistory.length < 1) {
        console.log("[agents-memory] Skipping write - insufficient context");
        messageCountSinceCompact = 0;
        return;
    }

    // ───────────────────────────────────────────────────────
    // Check if AI already saved (via PRE-LLM inject)
    // ───────────────────────────────────────────────────────
    let aiAlreadySaved = false;
    const lastUserMsg = conversationHistory[conversationHistory.length - 1];

    if (lastUserMsg && lastUserMsg.role === "user" && shouldSaveToMemory(lastUserMsg.content)) {
        // User requested save → check if AI responded with save confirmation
        const lastAssistantText = await getLastAssistantResponseFromSession(sessionKey);
        if (lastAssistantText && aiIndicatedSave(lastAssistantText)) {
            console.log("[agents-memory] AI already saved - skipping duplicate store");
            aiAlreadySaved = true;
        }
    }

    if (aiAlreadySaved) {
        // AI indicated it saved → just reset, don't duplicate
        conversationHistory = [];
        messageCountSinceCompact = 0;

        // Reset compaction tracking
        const tracking = sessionCompactionTracking.get(sessionKey);
        if (tracking) {
            tracking.msgCount = 0;
            tracking.lastCompactedMsgCount = 0;
        }
        return;
    }

    // ───────────────────────────────────────────────────────
    // No AI save → Use sessionCompactAfter as backup storage
    // ───────────────────────────────────────────────────────

    console.log("[agents-memory] Storing", conversationHistory.length, "conversations");

    for (let i = 0; i < conversationHistory.length; i++) {
        const entry = conversationHistory[i];
        await daemonCall("write", {
            problem: entry.content.slice(0, 200),
            solution: "",
            type: "learning",
            project: event.context && event.context.project || null,
            metadata: { session_id: sessionKey }
        });
        console.log(`[agents-memory] Stored ${i + 1}/${conversationHistory.length}`);
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
}

// ───────────────────────────────────────────────────────
// Compaction: Summarize working collection and consolidate
// ───────────────────────────────────────────────────────
async function executeCompaction(sessionKey) {
    console.log("[agents-memory] Executing compaction for session:", sessionKey);

    const tracking = sessionCompactionTracking.get(sessionKey);
    if (!tracking) {
        console.log("[agents-memory] No tracking for session, skipping compaction");
        return;
    }

    const sessionMsgCount = tracking.msgCount;
    const lastCompactedCount = tracking.lastCompactedMsgCount || 0;

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
        // Step 2: Generate summary (ask AI to do this)
        // ───────────────────────────────────────────────────────

        // ───────────────────────────────────────────────────────
        // Simple approach: concat messages and ask user/AI for summary
        // ───────────────────────────────────────────────────────

        const allText = allMessages.map(m => m.content || "").join("\n\n");
        const summaryPrompt = `Based on the following conversation messages, provide a concise summary:\n\n${allText}\n\nSummary should cover: main topic, key decisions, and current status.\n\nFormat: "{Topic} - Progress" followed by bullet points.`;

        const messagesSummary = `(Session has ${allMessages.length} messages) - Summarize all.`;

        console.log("[agents-memory] Summary prompt:", messagesSummary);
        console.log("[agents-memory] Injecting summary prompt for AI");

        event.messages.push({
            role: "system",
            content: summaryPrompt
        });

        // Note: For now, we don't wait for AI response to get the summary.
        // In future, can add hook for "message:final" or use callback pattern.

        // ───────────────────────────────────────────────────────
        // Step 3: Delete old entries and insert summary
        // ───────────────────────────────────────────────────────

        // For now, just delete all messages for this session
        // The AI will handle summarization and create new entry
        console.log("[agents-memory] Deleting old entries from working collection for session:", sessionKey);

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
    } else if (hook === "session:compact:after") {
        return sessionCompactAfter(event);
    }
}

module.exports = handler;
module.exports.default = handler;
module.exports.messagePreprocessed = messagePreprocessed;
module.exports.sessionCompactAfter = sessionCompactAfter;
