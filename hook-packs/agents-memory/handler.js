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
    
    // Skip commands for learning
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
        // ALWAYS: Inject save prompt for every message
        // ───────────────────────────────────────────────────────
        console.log("[agents-memory] Injecting save prompt for every message");
        event.messages.push({
            role: "system",
            content: `[memory] IMPORTANT: After your response, save to agents-memory using exec:

~/.npm-global/bin/agents-memory write "<brief problem summary>" -s "<key outcome or decision>" -t working --metadata '{"session_id":"${sessionKey || 'default'}"}'

Reply with "[memory saved]" at the end of your response.

Example: After answering about fixing the pipeline, run:
~/.npm-global/bin/agents-memory write "Fixed pipeline extraction issue" -s "Changed to read event.context.bodyForAgent, added cache variable, fixed snippet.length" -t working --metadata '{"session_id":"${sessionKey || 'default'}"}'`
        });
        
        // Check cache first
        const cached = getCached(cacheKey);
        let results;
        
        if (cached) {
            console.log("[agents-memory] Cache hit:", originalQuery.slice(0, 30) + "...");
            results = cached;
        } else {
            console.log("[agents-memory] Query:", originalQuery.slice(0, 30) + "...");
            
            // ───────────────────────────────────────────────────────
            // Step 1: LAWS — Always injected (unconditional)
            // ───────────────────────────────────────────────────────
            let lawsResults = [];
            try {
                const lawsResponse = await daemonCall("search", {
                    query: "LAWS_COLLECTION_QUERY",
                    collection: "laws",
                    limit: 50
                });
                lawsResults = lawsResponse && lawsResponse.data && lawsResponse.data.data || [];
                console.log("[agents-memory] Laws:", lawsResults.length, "entries");
            } catch (e) {
                console.warn("[agents-memory] Laws query failed:", e.message);
            }
            
            // ───────────────────────────────────────────────────────
            // Step 2: Working collection — AUTO-SAVE with AI response pairing
            // ───────────────────────────────────────────────────────
            try {
                // Clean up STALE pending messages (older than 2 minutes = user inactive)
                const STALE_THRESHOLD_MS = 120000; // 2 minutes
                const now = Date.now();
                
                for (const [key, pending] of pendingUserMessages.entries()) {
                    // Skip if already saved/inactive
                    if (pending.saved) {
                        continue;
                    }
                    
                    if (now - pending.timestamp > STALE_THRESHOLD_MS) {
                        // Stale pending found - save USER MESSAGE ONLY
                        // Can't reliably match AI response after time gap
                        console.log("[agents-memory] Found stale pending from", Math.floor((now - pending.timestamp) / 1000), "seconds ago - saving user msg only");
                        
                        const entry = {
                            problem: pending.userMsg.slice(0, 200),
                            solution: "(no AI response - user inactive)",
                            type: "working",
                            metadata: { 
                                session_id: key, 
                                role: "stale",
                                user_timestamp: pending.timestamp,
                                saved_timestamp: now
                            }
                        };
                        
                        await daemonCall("write", entry);
                        console.log("[agents-memory] Auto-saved stale pending:", pending.userMsg.slice(0, 20) + "...");
                        
                        // Mark as saved and remove
                        pending.saved = true;
                        pendingUserMessages.delete(key);
                        savePendingToFile();
                    }
                }
                
                // Read last AI response from session file
                const lastAIResponse = getLastAssistantMessageSync(sessionKey);
                
                // Check if there's a pending user message from before
                const pending = pendingUserMessages.get(sessionKey);
                
                if (pending && !pending.saved && lastAIResponse && lastAIResponse.length > 0) {
                    // Pair previous user message with its AI response
                    const pairEntry = {
                        problem: pending.userMsg.slice(0, 200),
                        solution: lastAIResponse.slice(0, 500),
                        type: "working",
                        metadata: { 
                            session_id: sessionKey, 
                            role: "paired",
                            user_timestamp: pending.timestamp,
                            ai_timestamp: Date.now()
                        }
                    };
                    
                    await daemonCall("write", pairEntry);
                    console.log("[agents-memory] Auto-saved paired (user+AI):", pending.userMsg.slice(0, 20) + "... + AI response");
                    
                    // Mark as saved and remove
                    pending.saved = true;
                    pendingUserMessages.delete(sessionKey);
                    savePendingToFile();
                }
                
                // Store current user message as pending (awaiting AI response)
                pendingUserMessages.set(sessionKey, {
                    userMsg: rawMsg,
                    timestamp: Date.now(),
                    saved: false  // not yet saved
                });
                savePendingToFile();
                console.log("[agents-memory] Stored pending user message:", rawMsg.slice(0, 30) + "...");
                
            } catch (e) {
                console.warn("[agents-memory] Auto-save failed:", e.message);
            }
            
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
            sessionTracking.msgCount++; // Increment for this message
            
            if (sessionTracking.msgCount >= COMPACTION_THRESHOLD) {
                console.log("[agents-memory] Threshold reached:", sessionTracking.msgCount, "/", "messages");
                
                // Inject explicit task
                event.messages.push({
                    role: "system",
                    content: `[memory: ${sessionTracking.msgCount} messages logged in 'working' collection for session ${sessionKey || 'unknown'}. Threshold: ${COMPACTION_THRESHOLD}. Consider requesting memory consolidation.]`
                });
            }
            
            // ───────────────────────────────────────────────────────
            // Step 4: Combine results and inject
            // ───────────────────────────────────────────────────────
            // Laws FIRST (unconditional), then working entries
            const allResults = [...(lawsResults || []), ...(workingResults || [])];
            
            if (!allResults.length) {
                console.log("[agents-memory] No results - skipping injection");
                return;
            }
            
            const snippets = allResults.slice(0, 3).map(r => {
                return extractSnippet(r, rawMsg);
            });
            
            let totalChars = 0;
            let contextParts = [];
            
            for (let i = 0; i < snippets.length; i++) {
                const snippet = snippets[i];
                if (totalChars + snippet.length + 50 > MAX_INJECT_CHARS) {
                    if (i === 0 && totalChars < MAX_INJECT_CHARS - 100) {
                        contextParts.push(snippet);
                        totalChars += snippet.length + 50;
                    }
                    break;
                } else {
                    contextParts.push(snippet);
                    totalChars += snippet.length + 50;
                }
            }
            
            if (contextParts.length) {
                const context = contextParts.join("\n");
                event.messages.push({
                    role: "system",
                    content: "Relevant context:\n" + context
                });
                console.log(`[agents-memory] Injected ${contextParts.length} snippets (${totalChars} chars, budget=${MAX_INJECT_CHARS})`);
            }
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
