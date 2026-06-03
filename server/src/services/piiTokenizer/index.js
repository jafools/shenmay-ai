/**
 * PII Tokenizer — public API.
 *
 * Transforms outbound text by replacing PII identifiers with opaque tokens
 * that Claude can still reason about (`[SSN_1]`, `[PHONE_1]`, `[PERSON_1]`),
 * then reverses the substitution on Claude's response before it reaches the
 * user. Runs entirely in-process; no new network calls, no new storage.
 *
 * ARCHITECTURE
 *   1. Build a `TokenMap` — per-call, in-memory, discarded after the call.
 *   2. Extract structural name hints from `memoryFile`/`soulFile` (so we
 *      can pseudonymize names without NLP).
 *   3. Tokenize the outbound text in two passes:
 *         a) Name pseudonymization (longest-first literal replacement).
 *         b) Regex-based detector sweep (SSN, CC, IBAN, email, phone, DOB,
 *            postcode, account).
 *   4. Breach detector re-scans the tokenized payload. If ANY regulated
 *      pattern remains, throw `BreachError` — caller blocks the request.
 *   5. On Claude's response, call `detokenize` to swap tokens back to
 *      their original values.
 *
 * USAGE
 *   const t = new Tokenizer({ memoryFile, soulFile });
 *   const { text, map } = t.tokenize(systemPrompt);
 *   const { messages: tokenizedMsgs } = t.tokenizeMessages(messages, map);
 *   t.auditOutbound(text, tokenizedMsgs);   // throws BreachError on leak
 *   // ...call Anthropic...
 *   const safeResponse = t.detokenize(response, map);
 */

'use strict';

const { TokenMap } = require('./tokenMap');
const { detectors } = require('./detectors');
const { extractNames } = require('./nameExtractor');
const { scan, scanMessages, BreachError } = require('./breachDetector');

// Hard per-string input cap for the detector sweep. All detectors are bounded/
// linear, but this is a defense-in-depth backstop so a single pathological
// outbound payload can never monopolize the single-threaded event loop (ReDoS
// class). Far above any legitimate prompt/message — the chat path caps user
// input at 4 KB upstream.
const MAX_TOKENIZE_INPUT = 128 * 1024;

class Tokenizer {
  /**
   * @param {object} opts
   * @param {object} [opts.memoryFile]  Decrypted memory blob (for name hints)
   * @param {object} [opts.soulFile]    Decrypted soul blob (for name hints)
   */
  constructor(opts = {}) {
    this._nameHints = extractNames(opts.memoryFile, opts.soulFile);
  }

  /**
   * Tokenize a plain-text blob. Returns { text, map }.
   * If `existingMap` is provided, tokens are added to it (so the same map
   * can be used across system prompt + all messages in one pass).
   */
  tokenize(text, existingMap = null) {
    const map = existingMap || new TokenMap();
    if (!text || typeof text !== 'string') return { text, map };

    let out = text;
    if (out.length > MAX_TOKENIZE_INPUT) {
      console.warn(`[piiTokenizer] outbound string ${out.length} bytes exceeds ${MAX_TOKENIZE_INPUT}-byte cap; truncating before detector sweep`);
      out = out.slice(0, MAX_TOKENIZE_INPUT);
    }

    // Pass 1: structured name pseudonymization (longest-first).
    for (const hint of this._nameHints) {
      if (!hint.original) continue;
      // Word-boundary safe replacement. Escape regex metacharacters in name.
      const escaped = hint.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Use boundary detection that works for names with spaces/apostrophes.
      const re = new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'g');
      out = out.replace(re, () => map.tokenFor(hint.original, hint.type || 'PERSON'));
    }

    // Pass 2: regex detectors.
    for (const d of detectors) {
      const pattern = new RegExp(d.pattern.source, d.pattern.flags);
      out = out.replace(pattern, (fullMatch, ...groups) => {
        // Validate before tokenizing.
        const matched = d.group ? groups[d.group - 1] : fullMatch;
        if (!matched) return fullMatch;
        if (d.validate && !d.validate(matched)) return fullMatch;

        const token = map.tokenFor(matched, d.NAME);
        // If the detector used a capture group (e.g. ACCOUNT), replace only
        // the captured portion, preserving surrounding context.
        if (d.group) {
          return fullMatch.replace(matched, token);
        }
        return token;
      });
    }

    return { text: out, map };
  }

  /**
   * Tokenize the full message-history array passed to Anthropic. Handles
   * both string-content messages and structured tool-use/tool-result blocks.
   */
  tokenizeMessages(messages, map) {
    if (!Array.isArray(messages)) return { messages, map };
    const out = messages.map(msg => {
      if (typeof msg.content === 'string') {
        const { text } = this.tokenize(msg.content, map);
        return { ...msg, content: text };
      }
      if (Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map(block => {
            if (typeof block === 'string') {
              const { text } = this.tokenize(block, map);
              return text;
            }
            if (block && typeof block === 'object') {
              // tool_result blocks: .content is string or array of {type:'text', text}
              if (typeof block.text === 'string') {
                const { text } = this.tokenize(block.text, map);
                return { ...block, text };
              }
              if (typeof block.content === 'string') {
                const { text } = this.tokenize(block.content, map);
                return { ...block, content: text };
              }
            }
            return block;
          }),
        };
      }
      return msg;
    });
    return { messages: out, map };
  }

  /**
   * Detokenize Claude's text response using the same map.
   * Unknown tokens (e.g. Claude hallucinated one) are left as-is — safe
   * failure mode that never leaks PII.
   */
  detokenize(text, map) {
    if (!map) return text;
    return map.detokenize(text);
  }

  /**
   * Breach-detect the tokenized outbound payload. Throws `BreachError`
   * if any residual PII pattern is found, which the caller translates
   * into a safe user-facing error (request is NEVER sent to Anthropic).
   *
   * @param {string} systemPrompt    Tokenized system prompt
   * @param {Array}  messages        Tokenized message array
   */
  auditOutbound(systemPrompt, messages) {
    const findings = [
      ...scan(systemPrompt).map(f => ({ ...f, location: 'system' })),
      ...scanMessages(messages),
    ];
    if (findings.length > 0) {
      throw new BreachError(findings);
    }
  }
}

module.exports = {
  Tokenizer,
  TokenMap,
  BreachError,
  _internal: { detectors, extractNames, scan, scanMessages },
};
