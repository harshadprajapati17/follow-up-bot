# V3 Bot Architecture

## What Changed from V2

V2 had 4 interception layers before Gemini (local resolver → keyword rules → fingerprint cache → Gemini). Each layer added fragmentation and caused bugs like "Harshad 8866574684" not being parsed correctly.

V3 removes all interception layers. Gemini owns the conversation.

```
V2: User → Local Resolver → Keyword Rules → Fingerprint Cache → Gemini
V3: User → Gemini  (greeting shortcut is the only bypass)
```

---

## Architecture

### Request Flow
1. Load conversation from MongoDB (`v3_conversations`)
2. If greeting + no active lead → instant reply (no Gemini cost)
3. Otherwise → Gemini with full conversation history + summary
4. If Gemini calls a tool → validate → execute → store result
5. Save updated conversation to MongoDB

### What Gemini Receives Each Call
- System prompt (always)
- Active lead ID (if any) — injected as context, Gemini can't know DB-generated IDs
- Conversation summary (if history was compacted)
- Last 15 messages

### Gemini Model
`gemini-2.5-pro` (configurable via `GEMINI_V3_MODEL` env var)

---

## Conversation Storage

### Working Memory vs Chat Log
These are two separate things:

| | Working Memory | Chat Log |
|---|---|---|
| **Purpose** | Gemini context for next call | User-facing history display |
| **Where** | `v3_conversations` MongoDB | React state (current session only) |
| **How long** | 7 days TTL + last 15 messages | Lost on browser refresh |
| **Size** | Always bounded (max 15 turns) | Grows during session |

> **Note:** Full persistent chat log (like WhatsApp history) is not implemented in V3. If needed, add a separate `chat_logs` collection that appends every message without trimming.

### What Happens After 7 Days of Inactivity
The conversation document is auto-deleted by MongoDB TTL index. The user starts a fresh conversation.

**This is intentional** — the important data (leads, visits, measurements, quotes) lives permanently in the `leads` collection and is never deleted. The bot can always retrieve recent leads via `list_recent_leads`.

To change the TTL, edit `conversation.ts`:
```ts
expireAfterSeconds: 7 * 24 * 60 * 60  // change 7 to desired days
```

### Conversation Summarization
When message count hits 20, the oldest 10 messages are sent to Gemini for summarization, then discarded. Only the summary + newest 10 messages are kept. This keeps token count flat regardless of how long a user has been active.

Summary is rolling — each new summary includes the previous one, so context accumulates cleanly.

---

## Files

| File | Purpose |
|---|---|
| `types.ts` | TypeScript types |
| `conversation.ts` | MongoDB load/save/summarize |
| `system-prompt.ts` | Gemini system prompt |
| `gemini.ts` | Tool declarations + Gemini API call |
| `core.ts` | Main request handler |

### Reused from V2 (no changes)
- `lib/v2/validation.ts` — phone format, enum, required field checks
- `lib/v2/tool-handlers.ts` — MongoDB/S3 execution for all 7 tools
- `lib/v2/quote-calculator.ts` — pricing engine
- `lib/v2/pricing-data.ts` — labour and material rates

---

## Product Decisions to Revisit

- **TTL duration** — currently 7 days. Change if users need longer memory between sessions.
- **MAX_MESSAGES** — currently 15. Increase if Gemini needs more context for complex flows.
- **Persistent chat display** — currently not implemented. Add if users need to scroll back old conversations.
- **Summarization threshold** — currently triggers at 20 messages. Tune based on real usage patterns.
