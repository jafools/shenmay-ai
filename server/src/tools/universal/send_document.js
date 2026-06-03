/**
 * TOOL: send_document
 *
 * Universal tool — works across any industry.
 * Emails a formatted document / report to the customer on file (the recipient is
 * always the authenticated customer's address — never a model-supplied one).
 *
 * Typical flow in an agentic session:
 *   1. Agent calls generate_report to assemble structured analysis
 *   2. Agent calls send_document with the formatted content to deliver it
 *
 * The tool handles:
 *   - Looking up the customer's email address (no need to ask them)
 *   - Formatting the content as a branded HTML email
 *   - Sending via SMTP
 *   - Logging the delivery to customer_data so advisors can see it in the dashboard
 *
 * For a financial firm:  account summary, withdrawal plan, retirement overview
 * For a healthcare firm: care plan, medication list, intake summary
 * For any vertical:      session recap, product comparison, next-steps memo
 */

const { sendDocumentEmail } = require('../../services/emailService');
const { isAnonVisitorEmail } = require('../../constants/anonDomains');

const name = 'send_document';

const defaultDescription =
  'Emails a formatted document or report to the client. ' +
  'Use after generate_report or when the client asks for something in writing — ' +
  'a session summary, a comparison, a plan overview, or any document they want to ' +
  'keep or share. The email is sent to the address on file; you can provide an ' +
  'override if the client gives a different address.';

const inputSchema = {
  type: 'object',
  properties: {
    subject: {
      type: 'string',
      description:
        'The email subject line. Should be descriptive and include the document type ' +
        '(e.g. "Your Account Summary — March 2026", "Session Recap: Goals & Next Steps").',
    },
    summary: {
      type: 'string',
      description:
        '1–3 sentence intro paragraph shown at the top of the email. ' +
        'Briefly describe what the document covers and why it was prepared.',
    },
    sections: {
      type: 'array',
      description:
        'The main content sections of the document. Each section has a heading and body text. ' +
        'Use plain prose — no markdown formatting, no bullet characters.',
      items: {
        type: 'object',
        properties: {
          heading: {
            type: 'string',
            description: 'Section heading (e.g. "Current Assets", "Action Plan", "Key Findings").',
          },
          content: {
            type: 'string',
            description:
              'Section body. Plain prose, 2–6 sentences. Numbers and specifics are valuable here.',
          },
        },
        required: ['heading', 'content'],
      },
    },
    next_steps: {
      type: 'array',
      description:
        'Optional list of recommended next steps or action items. Each item is a short, ' +
        'actionable sentence starting with a verb (e.g. "Review your IRA beneficiary designations").',
      items: { type: 'string' },
    },
    disclaimer: {
      type: 'string',
      description:
        'Optional custom disclaimer to append at the bottom. ' +
        'If omitted, a standard informational disclaimer is added automatically.',
    },
  },
  required: ['subject', 'summary', 'sections'],
};

async function handler(
  { subject, summary, sections, next_steps, disclaimer },
  { db, customerId, customer, tenant }
) {
  // 1. Resolve recipient email — ALWAYS the authenticated customer's on-file
  // address. The recipient is intentionally NOT taken from the model's tool
  // input: an LLM-/visitor-supplied recipient turned this into an authenticated
  // open-relay (a document from the platform's trusted SMTP to ANY address).
  // Anonymous sessions resolve to the @visitor placeholder and are refused below.
  const { rows } = await db.query(
    `SELECT email, first_name, last_name FROM customers WHERE id = $1`,
    [customerId]
  );
  if (!rows.length || !rows[0].email) {
    return {
      success: false,
      message:
        'Could not send the document: no email address found for this customer. ' +
        'Ask the customer to confirm their email address and try again.',
    };
  }
  const toEmail = rows[0].email;

  // Fill customer name if not on context
  if (!customer.first_name && rows[0].first_name) {
    customer = { ...customer, first_name: rows[0].first_name, last_name: rows[0].last_name };
  }

  // Don't send to anonymous visitor placeholder addresses
  if (isAnonVisitorEmail(toEmail)) {
    return {
      success: false,
      message:
        'This appears to be an anonymous session — no real email address on file. ' +
        'Ask the customer for their email address to send the document.',
    };
  }

  const customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'there';
  const agentName    = tenant?.agent_name || 'Your Assistant';
  const tenantName   = tenant?.name       || 'Shenmay AI';
  const today        = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // 2. Send the email
  await sendDocumentEmail({
    to:          toEmail,
    customerName,
    agentName,
    tenantName,
    subject,
    summary,
    sections:    sections || [],
    nextSteps:   next_steps && next_steps.length > 0 ? next_steps : null,
    disclaimer:  disclaimer || null,
  });

  // 3. Log delivery to customer_data for advisor visibility
  try {
    await db.query(
      `INSERT INTO customer_data
         (customer_id, category, label, value, value_type, metadata, source)
       VALUES ($1, 'sent_documents', $2, $3, 'text', $4::jsonb, 'agent')
       ON CONFLICT (customer_id, category, label) DO UPDATE SET
         value       = EXCLUDED.value,
         metadata    = EXCLUDED.metadata,
         recorded_at = NOW()`,
      [
        customerId,
        subject,
        today,
        JSON.stringify({
          sent_on:       today,
          sent_to:       toEmail,
          section_count: (sections || []).length,
        }),
      ]
    );
  } catch (_) {
    // Non-fatal — document still delivered
  }

  return {
    success: true,
    sent_to: toEmail,
    message:
      `The document "${subject}" has been sent to ${toEmail}. ` +
      `${customerName} should receive it within a few minutes. ` +
      `Let them know to check their inbox.`,
  };
}


module.exports = { name, defaultDescription, inputSchema, handler, category: 'communication' };
