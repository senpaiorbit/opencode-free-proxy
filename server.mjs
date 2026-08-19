import express from "express";
import crypto from "crypto";
import https from "https";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PROXY_PORT || 6446;
const OC_VERSION = "1.15.0";
const PROXY_VERSION = "10";

// ── API Keys ───────────────────────────────────────────────────────

const keysFile = process.env.KEYS_FILE || "./api-keys.json";
let apiKeys = {};

function loadKeys() {
  // Preferred: stable key supplied by Render/environment.
  const envKey = process.env.PROXY_API_KEY?.trim();

  if (envKey) {
    apiKeys = {
      "user-default": envKey,
    };

    console.log("[INIT] Using API key from PROXY_API_KEY");
    return;
  }

  // Optional additional environment keys.
  const envKeys = [
    process.env.PROXY_API_KEY_1,
    process.env.PROXY_API_KEY_2,
    process.env.PROXY_API_KEY_3,
  ]
    .map((key) => key?.trim())
    .filter(Boolean);

  if (envKeys.length > 0) {
    apiKeys = {};

    envKeys.forEach((key, index) => {
      apiKeys[`user-${index + 1}`] = key;
    });

    console.log(`[INIT] Using ${envKeys.length} API key(s) from environment`);
    return;
  }

  // Fallback to api-keys.json.
  try {
    apiKeys = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  } catch {
    apiKeys = {};
  }

  // Last resort: generate random keys.
  if (Object.keys(apiKeys).length === 0) {
    apiKeys = {
      admin: "oc-" + crypto.randomBytes(20).toString("hex"),
      "user-default": "oc-" + crypto.randomBytes(20).toString("hex"),
    };

    fs.writeFileSync(keysFile, JSON.stringify(apiKeys, null, 2));

    console.log("[INIT] Generated new API keys →", keysFile);
    console.log("[WARN] Configure PROXY_API_KEY for persistent authentication.");
  }
}

loadKeys();

// Constant-time API key comparison.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);

  if (aBuf.length !== bBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuf, bBuf);
}

function auth(req) {
  const authHeader = req.headers.authorization;
  const apiHeader = req.headers["x-api-key"];

  let token = "";

  if (typeof authHeader === "string" && authHeader.length > 0) {
    token = authHeader.replace(/^Bearer\s+/i, "").trim();
  } else if (typeof apiHeader === "string") {
    token = apiHeader.trim();
  }

  if (!token) {
    return null;
  }

  for (const [name, key] of Object.entries(apiKeys)) {
    if (safeEqual(token, key)) {
      return name;
    }
  }

  return null;
}

// ── Helpers ────────────────────────────────────────────────────────

function ocId(prefix) {
  const ts = Date.now().toString(16);
  const rnd = crypto.randomBytes(12).toString("base64url").slice(0, 16);

  return `${prefix}_${ts}${rnd}`;
}

const MODELS = [
  "deepseek-v4-flash-free",
  "big-pickle",
  "minimax-m2.5-free",
  "nemotron-3-super-free",
  "qwen3.6-plus-free",
];

// Track sessions per user.
// Sessions rotate every 30 minutes.
const userSessions = {};

function getSession(user) {
  const now = Date.now();

  if (
    !userSessions[user] ||
    now - userSessions[user].ts > 30 * 60 * 1000
  ) {
    userSessions[user] = {
      id: ocId("ses"),
      ts: now,
    };
  }

  return userSessions[user].id;
}

// ── Zen API transport ──────────────────────────────────────────────

function zenRequest(
  model,
  messages,
  stream,
  tools,
  tool_choice,
  sessionId
) {
  const reqBody = {
    model,
    messages,
    stream: !!stream,
  };

  if (tools?.length) {
    reqBody.tools = tools;
  }

  if (tool_choice) {
    reqBody.tool_choice = tool_choice;
  }

  const body = JSON.stringify(reqBody);
  const requestId = ocId("msg");

  return {
    body,

    options: {
      hostname: "opencode.ai",
      port: 443,
      path: "/zen/v1/chat/completions",
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),

        "Authorization": "Bearer public",

        "User-Agent":
          `opencode/${OC_VERSION} ` +
          "ai-sdk/provider-utils/4.0.23 " +
          "runtime/bun/1.3.13",

        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-request": requestId,
        "x-opencode-session": sessionId,
      },

      timeout: 120000,
    },
  };
}

// ── Pipe Zen response to client ───────────────────────────────────

function pipeZenResponse(zenOpts, body, stream, res) {
  const req = https.request(zenOpts, (zenRes) => {
    let firstChunk = null;
    let headersSent = false;

    zenRes.on("data", (chunk) => {
      if (!firstChunk) {
        firstChunk = chunk;

        const str = chunk.toString().trim();

        if (
          str.startsWith("{") &&
          (str.includes("FreeUsageLimitError") ||
            str.includes('"error"'))
        ) {
          try {
            const parsed = JSON.parse(str);

            if (parsed.error || parsed.type === "error") {
              const errMsg =
                parsed.error?.message ||
                parsed.message ||
                "Rate limit exceeded";

              console.log("[ZEN ERROR]", errMsg);

              if (!res.headersSent) {
                res.status(429).json({
                  error: {
                    message: errMsg + " (free model rate limit)",
                    type: "rate_limit_error",
                    code: "rate_limit_exceeded",
                  },
                });
              }

              zenRes.resume();
              return;
            }
          } catch {}
        }

        headersSent = true;

        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
            "Transfer-Encoding": "chunked",
          });

          res.flushHeaders();
        } else {
          res.writeHead(zenRes.statusCode || 200, {
            "Content-Type": "application/json",
          });
        }

        res.write(firstChunk);

        if (res.flush) {
          res.flush();
        }

        return;
      }

      if (headersSent) {
        res.write(chunk);

        if (res.flush) {
          res.flush();
        }
      }
    });

    zenRes.on("end", () => {
      if (!headersSent && !firstChunk) {
        console.log("[ZEN EMPTY] No response from Zen API");

        if (!res.headersSent) {
          res.status(502).json({
            error: {
              message: "Empty response from upstream",
              type: "upstream_error",
            },
          });
        }

        return;
      }

      if (headersSent) {
        res.end();
      }
    });

    zenRes.on("error", (e) => {
      console.log("[ZEN RESPONSE ERROR]", e.message);

      if (!res.headersSent) {
        res.status(502).json({
          error: {
            message: "Upstream response error: " + e.message,
            type: "upstream_error",
          },
        });
      }
    });
  });

  req.on("error", (e) => {
    console.log("[ZEN ERROR]", e.message);

    if (!res.headersSent) {
      res.status(502).json({
        error: {
          message: "Upstream error: " + e.message,
          type: "upstream_error",
        },
      });
    }
  });

  req.on("timeout", () => {
    req.destroy();

    console.log("[ZEN TIMEOUT]");

    if (!res.headersSent) {
      res.status(504).json({
        error: {
          message: "Upstream timeout",
          type: "timeout_error",
        },
      });
    }
  });

  req.write(body);
  req.end();
}

// ── Collect full Zen response ──────────────────────────────────────

function zenRequestFull(zenOpts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(zenOpts, (zenRes) => {
      const chunks = [];

      zenRes.on("data", (c) => {
        chunks.push(c);
      });

      zenRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString();

        try {
          resolve({
            status: zenRes.statusCode,
            data: JSON.parse(raw),
            raw,
          });
        } catch {
          resolve({
            status: zenRes.statusCode,
            data: null,
            raw,
          });
        }
      });

      zenRes.on("error", reject);
    });

    req.on("error", reject);

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });

    req.write(body);
    req.end();
  });
}

// ── Anthropic Messages → OpenAI conversion ─────────────────────────

function anthropicToOpenAI(body) {
  const messages = [];

  if (body.system) {
    const sys =
      typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system)
          ? body.system.map((b) => b.text || "").join("\n")
          : "";

    if (sys) {
      messages.push({
        role: "system",
        content: sys,
      });
    }
  }

  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({
        role: msg.role,
        content: msg.content,
      });

      continue;
    }

    if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      const toolUses = msg.content.filter(
        (b) => b.type === "tool_use"
      );

      if (toolUses.length && msg.role === "assistant") {
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolUses.map((t) => ({
            id: t.id,
            type: "function",
            function: {
              name: t.name,
              arguments: JSON.stringify(t.input || {}),
            },
          })),
        });
      } else if (
        msg.content.some((b) => b.type === "tool_result")
      ) {
        for (const b of msg.content.filter(
          (b) => b.type === "tool_result"
        )) {
          const resultText =
            typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content)
                ? b.content.map((c) => c.text || "").join("\n")
                : "";

          messages.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content: resultText,
          });
        }
      } else {
        messages.push({
          role: msg.role,
          content: text,
        });
      }
    }
  }

  const tools = (body.tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || {},
    },
  }));

  return {
    messages,
    tools: tools.length ? tools : undefined,
  };
}

// ── OpenAI response → Anthropic Messages ───────────────────────────

function openAIToAnthropic(oaiResp, model, inputTokens) {
  const choice = oaiResp.choices?.[0];

  if (!choice) {
    return {
      id: ocId("msg"),
      type: "message",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "",
        },
      ],
      model,
      stop_reason: "end_turn",
      usage: {
        input_tokens: inputTokens || 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
  }

  const content = [];

  if (choice.message?.content) {
    content.push({
      type: "text",
      text: choice.message.content,
    });
  }

  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {};

      try {
        input = JSON.parse(tc.function.arguments);
      } catch {}

      content.push({
        type: "tool_use",
        id: tc.id || ocId("toolu"),
        name: tc.function.name,
        input,
      });
    }
  }

  if (!content.length) {
    content.push({
      type: "text",
      text: "",
    });
  }

  let stopReason = "end_turn";

  if (choice.finish_reason === "tool_calls") {
    stopReason = "tool_use";
  } else if (choice.finish_reason === "length") {
    stopReason = "max_tokens";
  } else if (choice.finish_reason === "stop") {
    stopReason = "end_turn";
  }

  return {
    id: ocId("msg"),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,

    usage: {
      input_tokens:
        oaiResp.usage?.prompt_tokens || inputTokens || 0,
      output_tokens:
        oaiResp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

// ── Stream OpenAI SSE → Anthropic SSE ──────────────────────────────

function pipeZenAsAnthropic(
  zenOpts,
  body,
  model,
  res,
  inputTokens
) {
  const msgId = ocId("msg");

  const req = https.request(zenOpts, (zenRes) => {
    let headersSent = false;
    let buffer = "";
    let outputTokens = 0;
    let contentIdx = 0;
    let toolIdx = -1;
    let firstChunkHandled = false;

    function sendSSE(event, data) {
      res.write(
        `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      );

      if (res.flush) {
        res.flush();
      }
    }

    function sendHeaders() {
      if (headersSent) {
        return;
      }

      headersSent = true;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      res.flushHeaders();

      sendSSE("message_start", {
        type: "message_start",

        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,

          usage: {
            input_tokens: inputTokens || 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });
    }

    zenRes.on("data", (chunk) => {
      const str = chunk.toString();

      if (!firstChunkHandled) {
        firstChunkHandled = true;

        const trimmed = str.trim();

        if (
          trimmed.startsWith("{") &&
          (trimmed.includes("FreeUsageLimitError") ||
            trimmed.includes('"error"'))
        ) {
          try {
            const parsed = JSON.parse(trimmed);

            if (parsed.error || parsed.type === "error") {
              const errMsg =
                parsed.error?.message ||
                parsed.message ||
                "Rate limit";

              if (!res.headersSent) {
                res.writeHead(429, {
                  "Content-Type": "application/json",
                });

                res.end(
                  JSON.stringify({
                    type: "error",
                    error: {
                      type: "rate_limit_error",
                      message:
                        errMsg +
                        " (free model rate limit)",
                    },
                  })
                );
              }

              zenRes.resume();
              return;
            }
          } catch {}
        }
      }

      buffer += str;

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          continue;
        }

        const payload = line.slice(6).trim();

        if (payload === "[DONE]") {
          continue;
        }

        let parsed;

        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        const delta = parsed.choices?.[0]?.delta;

        if (!delta) {
          continue;
        }

        sendHeaders();

        // Text content
        if (delta.content) {
          if (contentIdx === 0 && toolIdx === -1) {
            sendSSE("content_block_start", {
              type: "content_block_start",
              index: 0,

              content_block: {
                type: "text",
                text: "",
              },
            });

            contentIdx = 1;
          }

          sendSSE("content_block_delta", {
            type: "content_block_delta",
            index: 0,

            delta: {
              type: "text_delta",
              text: delta.content,
            },
          });

          outputTokens += Math.ceil(
            delta.content.length / 4
          );
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;

            if (idx > toolIdx) {
              if (toolIdx === -1 && contentIdx > 0) {
                sendSSE("content_block_stop", {
                  type: "content_block_stop",
                  index: 0,
                });
              }

              toolIdx = idx;

              const blockIdx =
                contentIdx > 0 ? idx + 1 : idx;

              sendSSE("content_block_start", {
                type: "content_block_start",
                index: blockIdx,

                content_block: {
                  type: "tool_use",
                  id: tc.id || ocId("toolu"),
                  name: tc.function?.name || "",
                },
              });
            }

            if (tc.function?.arguments) {
              const blockIdx =
                contentIdx > 0 ? idx + 1 : idx;

              sendSSE("content_block_delta", {
                type: "content_block_delta",
                index: blockIdx,

                delta: {
                  type: "input_json_delta",
                  partial_json: tc.function.arguments,
                },
              });

              outputTokens += Math.ceil(
                tc.function.arguments.length / 4
              );
            }
          }
        }

        // Finish
        if (parsed.choices?.[0]?.finish_reason) {
          const fr =
            parsed.choices[0].finish_reason;

          const totalBlocks =
            (contentIdx > 0 ? 1 : 0) +
            (toolIdx >= 0 ? toolIdx + 1 : 0);

          for (let i = 0; i < totalBlocks; i++) {
            sendSSE("content_block_stop", {
              type: "content_block_stop",
              index: i,
            });
          }

          let stopReason = "end_turn";

          if (fr === "tool_calls") {
            stopReason = "tool_use";
          } else if (fr === "length") {
            stopReason = "max_tokens";
          }

          sendSSE("message_delta", {
            type: "message_delta",

            delta: {
              stop_reason: stopReason,
            },

            usage: {
              output_tokens: outputTokens,
            },
          });

          sendSSE("message_stop", {
            type: "message_stop",
          });
        }
      }
    });

    zenRes.on("end", () => {
      if (!headersSent) {
        if (!res.headersSent) {
          res.status(502).json({
            type: "error",

            error: {
              type: "upstream_error",
              message: "Empty response",
            },
          });
        }

        return;
      }

      res.end();
    });

    zenRes.on("error", (e) => {
      console.log("[ZEN RESPONSE ERROR]", e.message);

      if (!res.headersSent) {
        res.status(502).json({
          type: "error",

          error: {
            type: "upstream_error",
            message: e.message,
          },
        });
      }
    });
  });

  req.on("error", (e) => {
    console.log("[ZEN ERROR]", e.message);

    if (!res.headersSent) {
      res.status(502).json({
        type: "error",

        error: {
          type: "upstream_error",
          message: e.message,
        },
      });
    }
  });

  req.on("timeout", () => {
    req.destroy();

    if (!res.headersSent) {
      res.status(504).json({
        type: "error",

        error: {
          type: "timeout_error",
          message: "Upstream timeout",
        },
      });
    }
  });

  req.write(body);
  req.end();
}

// ── Routes: OpenAI format ──────────────────────────────────────────

app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",

    data: MODELS.map((id) => ({
      id,
      object: "model",
      created: 1779000000,
      owned_by: "opencode-free",
    })),
  });
});

app.post("/v1/chat/completions", (req, res) => {
  const user = auth(req);

  if (!user) {
    return res.status(401).json({
      error: {
        message: "Invalid API key",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    });
  }

  const {
    model,
    messages,
    stream,
    tools,
    tool_choice,
  } = req.body;

  if (!MODELS.includes(model)) {
    return res.status(400).json({
      error: {
        message:
          `Unknown model: ${model}. ` +
          `Available: ${MODELS.join(", ")}`,
      },
    });
  }

  const sessionId = getSession(user);

  const msgSummary = (messages || []).map((m) => ({
    role: m.role,

    len:
      typeof m.content === "string"
        ? m.content.length
        : JSON.stringify(m.content || "").length,
  }));

  console.log(
    "[OAI]",
    new Date().toISOString(),
    user,
    model,
    stream ? "stream" : "sync",
    "msgs:",
    JSON.stringify(msgSummary)
  );

  const { body, options } = zenRequest(
    model,
    messages,
    stream,
    tools,
    tool_choice,
    sessionId
  );

  pipeZenResponse(options, body, stream, res);
});

// ── Routes: Anthropic Messages format ──────────────────────────────

app.post("/v1/messages", async (req, res) => {
  const user = auth(req);

  if (!user) {
    return res.status(401).json({
      type: "error",

      error: {
        type: "authentication_error",
        message: "Invalid API key",
      },
    });
  }

  const { model, stream } = req.body;

  if (!MODELS.includes(model)) {
    return res.status(400).json({
      type: "error",

      error: {
        type: "invalid_request_error",

        message:
          `Unknown model: ${model}. ` +
          `Available: ${MODELS.join(", ")}`,
      },
    });
  }

  const sessionId = getSession(user);

  const { messages, tools } =
    anthropicToOpenAI(req.body);

  const inputTokens =
    (JSON.stringify(messages).length / 4) | 0;

  console.log(
    "[ANT]",
    new Date().toISOString(),
    user,
    model,
    stream ? "stream" : "sync",
    "msgs:",
    messages.length
  );

  const { body, options } = zenRequest(
    model,
    messages,
    stream,
    tools,
    undefined,
    sessionId
  );

  if (stream) {
    pipeZenAsAnthropic(
      options,
      body,
      model,
      res,
      inputTokens
    );
  } else {
    try {
      const zenResp =
        await zenRequestFull(options, body);

      if (
        zenResp.status === 429 ||
        zenResp.data?.error
      ) {
        const errMsg =
          zenResp.data?.error?.message ||
          "Rate limit exceeded";

        return res.status(429).json({
          type: "error",

          error: {
            type: "rate_limit_error",
            message:
              errMsg +
              " (free model rate limit)",
          },
        });
      }

      if (!zenResp.data?.choices) {
        return res.status(502).json({
          type: "error",

          error: {
            type: "upstream_error",
            message: "Invalid upstream response",
          },
        });
      }

      res.json(
        openAIToAnthropic(
          zenResp.data,
          model,
          inputTokens
        )
      );
    } catch (e) {
      console.log("[ZEN ERROR]", e.message);

      res.status(502).json({
        type: "error",

        error: {
          type: "upstream_error",
          message: e.message,
        },
      });
    }
  }
});

// ── Health ──────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: `v${PROXY_VERSION}`,
    models: MODELS.length,

    authentication: {
      configured: Object.keys(apiKeys).length > 0,
      source: process.env.PROXY_API_KEY
        ? "environment"
        : "file-or-generated",
    },

    endpoints: [
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/models",
    ],
  });
});

// ── Start ──────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `OpenCode Free Proxy v${PROXY_VERSION} ` +
    `on http://0.0.0.0:${PORT}`
  );

  console.log(
    "  OpenAI:    POST /v1/chat/completions"
  );

  console.log(
    "  Anthropic: POST /v1/messages"
  );

  console.log(
    "  Models:    GET  /v1/models"
  );

  console.log(
    "  Health:    GET  /health"
  );

  console.log(
    "  Models:",
    MODELS.join(", ")
  );

  // Never print the actual API keys.
  for (const name of Object.keys(apiKeys)) {
    console.log(`  ${name.padEnd(15)} [configured]`);
  }
});
