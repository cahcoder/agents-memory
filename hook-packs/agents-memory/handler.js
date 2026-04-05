/**
 * agents-memory Managed Hook (CommonJS)
 * Events: message:preprocessed, session:compact:after
 */

const net = require("net");
const path = require("path");

const SOCKET = process.env.HOME + "/.memory/agents-memory/daemon.sock";
const MEMORY_DIR = process.env.HOME + "/.memory/agents-memory";

// ───────────────────────────────────────────────────────────────
// DAEMON COMMUNICATION
// ───────────────────────────────────────────────────────────────
function daemonCall(cmd, args) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCKET, () => {
      s.write(JSON.stringify({cmd, args}));
      s.end();
    });
    let data = "";
    s.on("data", c => data += c);
    s.on("end", () => { 
      try { 
        const r = JSON.parse(data); 
        r.ok ? resolve(r.data) : reject(new Error(r.error)) 
      } catch { reject(new Error("parse error")) } 
    });
    s.on("error", reject);
    s.setTimeout(5000, () => { s.destroy(); reject(new Error("timeout")) });
  });
}

// ───────────────────────────────────────────────────────────────
// IN-MEMORY STORE (persists across hook invocations)
// ───────────────────────────────────────────────────────────────
let lastUserMessage = null;
let lastAssistantResponse = null;
let messageCountSinceCompact = 0;

// ───────────────────────────────────────────────────────────────
// MESSAGE EXTRACTION
// ───────────────────────────────────────────────────────────────
function getMessageBody(event) {
  const ctx = event && event.context;
  if (!ctx) return null;
  return ctx.bodyForAgent || ctx.body || null;
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

// ───────────────────────────────────────────────────────────────
// PRE-LLM: Query memory + track conversation
// ───────────────────────────────────────────────────────────────
async function messagePreprocessed(event) {
  const msg = getMessageBody(event);
  if (!msg || msg.length < 3) return;
  
  // Track conversation for POST-LLM
  lastUserMessage = msg;
  lastAssistantResponse = null; // Will be set after AI responds
  messageCountSinceCompact++;
  
  try {
    console.log("[agents-memory] Query: " + msg.slice(0,50) + "...");
    const results = await daemonCall("search", {query: msg, limit: 3});
    if (results && results.length) {
      const context = results.slice(0,3).map(r => "[" + (r.collection || "memory") + "] " + (r.content || "").slice(0,150)).join("\n");
      event.messages.push({role: "system", content: "Relevant context:\n" + context});
      console.log("[agents-memory] Injected " + context.length + " chars");
    }
  } catch (e) {
    console.warn("[agents-memory] Error:", e.message);
  }
}

// ───────────────────────────────────────────────────────────────
// POST-LLM: Store learning after compaction
// ───────────────────────────────────────────────────────────────
async function sessionCompactAfter(event) {
  console.log("[agents-memory] Session compacted, checking for learnings...");
  
  // Only write if we have a conversation pair and enough messages exchanged
  if (!lastUserMessage || messageCountSinceCompact < 2) {
    console.log("[agents-memory] Skipping write - insufficient context");
    messageCountSinceCompact = 0;
    return;
  }
  
  // The lastAssistantResponse would need to be extracted from the session
  // For now, store the user message as a learning prompt
  // In a full implementation, we'd read the session file to get the AI response
  
  try {
    // Try to read the last exchange from session if we have sessionFile
    let assistantResponse = lastAssistantResponse;
    
    // If we don't have assistant response yet, try to extract from event
    // In a full implementation, we'd read the session file
    if (!assistantResponse && event.sessionFile) {
      // Could read session file here to get latest AI response
      // For now, use placeholder
      assistantResponse = "(see session file for details)";
    }
    
    // Write learning to memory
    const learning = {
      problem: lastUserMessage.slice(0, 200),
      solution: assistantResponse || "(AI response captured in session)",
      type: "learning",
      messagesSinceCompact: messageCountSinceCompact
    };
    
    await daemonCall("write", {
      problem: learning.problem,
      solution: learning.solution,
      collection: "tasks"
    });
    
    console.log("[agents-memory] ✅ Stored learning:", learning.problem.slice(0,50));
    
    // Reset after write
    lastUserMessage = null;
    lastAssistantResponse = null;
    messageCountSinceCompact = 0;
    
  } catch (e) {
    console.warn("[agents-memory] POST-LLM write error:", e.message);
  }
}

// ───────────────────────────────────────────────────────────────
// DISPATCHER
// ───────────────────────────────────────────────────────────────
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
