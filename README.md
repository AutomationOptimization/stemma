# Stemma

**The anatomy of a rumour.** A group passes one message down a chain — each person sees only
what the last one handed them — and the app reveals exactly how it mutated: what got dropped,
exaggerated, warped, or invented, and by whom.

Named for the term in textual criticism for the family tree showing how copies of a manuscript
diverged from a lost original.

## What makes it more than a relay

**Blinding is enforced server-side.** The Durable Object builds a *different* payload per
connection (`viewFor(playerId)` in `src/worker.js`). The in-flight text is only ever placed in
the payload for the player whose turn it is — not the host, not the shared screen, not the other
phones. It isn't hidden with CSS; it never crosses the wire.

**AI confederates.** In social-psych experiments a *confederate* is a planted participant. Here,
AI players sit in the chain with a known Bartlett bias, so a group of two can still run a long
chain — and so a specific distortion can be watched doing its work:

| Persona | Bias |
|---|---|
| The Summarizer | leveling — compresses, drops specifics |
| The Storyteller | sharpening — seizes a vivid detail and amplifies it |
| The Rationalizer | assimilation — reshapes oddities into the expected script |
| The Careful One | faithful (control) |

Observed in testing: the Rationalizer turned *bakery* into *animal shelter* — textbook assimilation.

**Two-layer analysis.** Every number is computed deterministically in `src/drift.js` (zero model
calls); the model only judges and narrates on top. A cold GPU degrades the prose, never the reveal.

- Deterministic: LCS word diff, blended fidelity (trigram cosine + Jaccard + Levenshtein),
  intensity ladders (`a bunch → dozens`), digit/word number equivalence, proper-noun loss,
  negation flips, hedge deltas, per-hop and cumulative decay.
- Model-driven: proposition decomposition, per-hop NLI-style entailment (`intact / weakened /
  distorted / dropped` + invention) feeding an alluvial ribbon diagram, and abductive attribution
  naming the cognitive mechanism behind the biggest mutation.

## Architecture

Cloudflare Workers + one Durable Object per room (SQLite storage class, free-plan compatible),
WebSocket hibernation, static assets from the same Worker.

```
src/worker.js   Worker router + Room Durable Object (blinding, turn order, confederates)
src/drift.js    deterministic serial-reproduction analysis
src/usher.js    model proxy: entailment, personas, abduction, narration
public/app.js   frontend + alluvial diagram (hand-written SVG)
public/index.html  editorial design system
```

### Inference endpoint

Model calls go through the Worker, never the browser — the Modal endpoint sends **no CORS
headers**, and this keeps the key server-side. It scales to zero and returns HTTP 303 for a
~2min cold start, so the Worker pre-warms `/health` when a game starts and every call is
best-effort.

```bash
npx wrangler secret put USHER_KEY   # OpenAI-compatible key
npx wrangler deploy
```

Set `USHER_BASE` in `wrangler.toml` to any OpenAI-compatible `/v1` base URL.

## Status

Working: the game, blinding, reconnection, host-skip for dropped players, AI confederates,
deterministic analysis, entailment flow, abduction, narration, editorial UI.

Known rough edges:
- Entailment calibration is imperfect on a quantized 7B — it can mark a paraphrased claim as
  dropped.
- The alluvial ribbon diagram is implemented and its data verified correct, but has not been
  visually confirmed against a live reveal.
