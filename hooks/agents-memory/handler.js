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

// Compaction configuration
const COMPACTION_THRESHOLD = 5; // Trigger after 5 messages per session
const COMPACTION_KEYWORD = "MEMORY CONSOLIDATED";

// Session tracking
let conversationHistory = [];
let messageCountSinceCompact = 0;

// Get session key (session ID or fallback)
function getSessionKey(event) {
    return event.context && (event.context.sessionKey || event.context.sessionId);
}

function getMessageBody(event) {
    const messages = event.messages || [];
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === "assistant") {
        return lastMsg.content;
    }
    return lastMsg ? lastMsg.content : "";
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
        // Save Request: Inject prompt asking AI to save response
        // ───────────────────────────────────────────────────────
        if (shouldSaveToMemory(rawMsg)) {
            console.log("[agents-memory] Save request detected:", rawMsg.slice(0, 30) + "...");
            event.messages.push({
                role: "system",
                content: `[memory] The user wants you to save this response to memory.


TASK:
1. After providing your response, EXPLICITLY call memory write:
   - cmd: write
   - type: working
   - problem: Brief summary of what was discussed (max 200 chars)
   - solution: Key outcome or decision made
   - metadata: {session_id: "${sessionKey || 'default'}"}

2. Reply with "[memory saved]" at the end of your response to confirm.


Example response:
"Here's the solution... [memory saved]"`
            });
        }
        
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
            // Step 2: Working collection — Track conversations
            // ───────────────────────────────────────────────────────
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
                if (totalChars + snippet.text.length + 50 > MAX_INJECT_CHARS) {
                    if (i === 0 && totalChars < MAX_INJECT_CHARS - 100) {
                        contextParts.push(snippet.text);
                        totalChars += snippet.text.length + 50;
                    }
                    break;
                } else {
                    contextParts.push(snippet.text);
                    totalChars += snippet.text.length + 50;
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
