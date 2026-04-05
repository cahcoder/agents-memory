/**
 * agents-memory Managed Hook (CommonJS)
 * Events: message:preprocessed, session:compact:after
 * 
 * Event structure from OpenClaw: { type, action, sessionKey, context, messages, timestamp }
 * Hook name format: "type:action" (e.g., "message:preprocessed")
 */

const net = require("net");

const SOCKET = process.env.HOME + "/.memory/agents-memory/daemon.sock";

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

function getLastUserMsg(messages) {
  if (!messages || !messages.length) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user" && m.content) {
      const c = Array.isArray(m.content) ? m.content.find(x => x && x.type === "text").text : m.content;
      if (c) return c;
    }
    if (typeof m.content === "string" && m.content.length > 0) return m.content;
  }
  return null;
}

async function messagePreprocessed(event) {
  const ctx = event && event.context;
  const messages = ctx && ctx.messages;
  console.log("[agents-memory] context keys:", ctx && Object.keys(ctx).join(","), "messages count:", messages && messages.length);
  const msg = getLastUserMsg(messages);
  console.log("[agents-memory] msg found:", msg ? msg.slice(0,50) : null);
  if (!msg || msg.length < 3) return;
  
  try {
    console.log("[agents-memory] Query: " + msg.slice(0,30) + "...");
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

async function sessionCompactAfter(event) {
  console.log("[agents-memory] Session compacted");
}

// Default export - dispatcher
async function handler(event) {
  const hook = event && event.type && event.action ? (event.type + ":" + event.action) : undefined;
  console.log("[agents-memory] Hook triggered, hook=", hook);
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
