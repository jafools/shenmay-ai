/**
 * Breach Detector — after tokenization, scans the outbound payload for
 * anything that still looks like a regulated identifier. If any matches
 * are found, the request is BLOCKED (the caller throws a safe error) and
 * a structured audit log entry is written.
 *
 * This is the second line of defence: the primary tokenizer should catch
 * everything, but reality is messy — the detector exists so that a single
 * missed pattern causes a safe failure, not a silent leak.
 */

'use strict';

const { detectors } = require('./detectors');

// Mirror the tokenizer's per-string cap so the re-scan can't be turned into an
// event-loop DoS either. In the normal egress path the text reaching here is
// already tokenizer-bounded; this also protects direct scan() callers (e.g.
// brand-learning residual-PII scans).
const MAX_SCAN_INPUT = 128 * 1024;

/**
 * The patterns the breach detector uses. Same as the main detectors, but
 * we deliberately re-scan to catch anything the tokenizer missed.
 */
function scan(text) {
  if (!text) return [];
  if (text.length > MAX_SCAN_INPUT) text = text.slice(0, MAX_SCAN_INPUT);

  const findings = [];
  for (const d of detectors) {
    const pattern = new RegExp(d.pattern.source, d.pattern.flags);
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const matched = d.group ? m[d.group] : m[0];
      if (!matched) continue;
      if (d.validate && !d.validate(matched)) continue;
      findings.push({
        type:       d.NAME,
        sample:     matched.length > 16 ? matched.slice(0, 8) + '...' + matched.slice(-4) : matched,
        offset:     m.index,
      });
    }
  }
  return findings;
}

/**
 * Scan a structured message payload (the array passed to Anthropic's
 * `messages` field) for residual PII. Returns an array of findings.
 */
function scanMessages(messages) {
  const findings = [];
  if (!Array.isArray(messages)) return findings;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (typeof msg.content === 'string') {
      for (const f of scan(msg.content)) {
        findings.push({ ...f, messageIndex: i, role: msg.role });
      }
    } else if (Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        const txt = typeof block === 'string' ? block
          : (block && typeof block.text === 'string') ? block.text
          : (block && typeof block.content === 'string') ? block.content
          : null;
        if (!txt) continue;
        for (const f of scan(txt)) {
          findings.push({ ...f, messageIndex: i, role: msg.role, blockIndex: j });
        }
      }
    }
  }
  return findings;
}

/**
 * BreachError — thrown when the detector finds unredacted PII in an
 * outbound payload. The error is caught at the llmService boundary and
 * translated into a safe user-facing response.
 */
class BreachError extends Error {
  constructor(findings) {
    super(`PII breach detector blocked outbound request: ${findings.length} residual finding(s)`);
    this.name = 'BreachError';
    this.findings = findings;
    this.code = 'PII_BREACH_DETECTED';
  }
}

module.exports = { scan, scanMessages, BreachError };
