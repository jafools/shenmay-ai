/**
 * SHENMAY AI — Custom Tool Handler
 *
 * Executes custom tools defined by tenants in the custom_tools table.
 * No code ever needs to be written — behaviour is driven entirely by
 * the tool's `tool_type` and `config` fields.
 *
 * tool_type dispatch:
 *   lookup    → fetches customer_data rows by category
 *   calculate → computes aggregates from customer_data
 *   report    → delegates to the universal generate_report handler
 *   escalate  → delegates to the universal request_specialist handler
 *   connect   → fires an outbound webhook to the tenant's own system
 *
 * @param {object} toolRow   — row from custom_tools table
 * @param {object} params    — Claude's parsed tool input (may be empty)
 * @param {object} context   — { db, tenantId, customerId, conversationId, customer, tenant }
 */

const { handler: generateReport }     = require('./universal/generate_report');
const { handler: requestSpecialist }  = require('./universal/request_specialist');
const { validateWebhookUrl }          = require('../utils/validateWebhookUrl');

async function handleCustomTool(toolRow, params, context) {
  const { tool_type, config = {}, display_name, name } = toolRow;
  const { db, customerId } = context;

  switch (tool_type) {

    // ── lookup ────────────────────────────────────────────────────────────────
    // Fetches records from customer_data, optionally filtered by a specific
    // category defined in the tool config.
    case 'lookup': {
      const category = config.data_category || params.category || null;

      let query = `
        SELECT category, label, value, secondary_value, metadata, recorded_at
        FROM customer_data
        WHERE customer_id = $1
      `;
      const queryParams = [customerId];

      if (category) {
        query += ` AND category = $2`;
        queryParams.push(category);
      }

      query += ` ORDER BY category, recorded_at DESC`;

      const { rows } = await db.query(query, queryParams);

      if (rows.length === 0) {
        return {
          found:    false,
          category: category || 'all',
          message:  `No data found${category ? ` in category "${category}"` : ''} for this client.`,
        };
      }

      // Group by category
      const grouped = {};
      let grandTotal = 0;

      for (const row of rows) {
        if (!grouped[row.category]) {
          grouped[row.category] = { records: [], category_total: 0 };
        }
        grouped[row.category].records.push({
          label:           row.label,
          value:           row.value,
          secondary_value: row.secondary_value,
          metadata:        row.metadata,
          recorded_at:     row.recorded_at,
        });
        if (row.value && !isNaN(parseFloat(row.value))) {
          grouped[row.category].category_total += parseFloat(row.value);
          grandTotal += parseFloat(row.value);
        }
      }

      return {
        found:         true,
        total_records: rows.length,
        grand_total:   grandTotal,
        categories:    grouped,
      };
    }

    // ── calculate ─────────────────────────────────────────────────────────────
    // Computes a numeric aggregate (total, average, count) over a category
    // of customer_data records.
    case 'calculate': {
      const category = config.data_category || params.category || null;
      const metric   = config.metric || params.metric || 'total';

      if (!category) {
        return {
          error: `Tool "${display_name}" is misconfigured — no data_category set.`,
        };
      }

      const { rows } = await db.query(
        `SELECT value FROM customer_data
         WHERE customer_id = $1 AND category = $2 AND value IS NOT NULL`,
        [customerId, category]
      );

      const numericValues = rows
        .map(r => parseFloat(r.value))
        .filter(v => !isNaN(v));

      if (numericValues.length === 0) {
        return {
          found:    false,
          category,
          metric,
          message:  `No numeric data found in category "${category}" for this client.`,
        };
      }

      const total   = numericValues.reduce((a, b) => a + b, 0);
      const average = total / numericValues.length;
      const count   = numericValues.length;
      const min     = Math.min(...numericValues);
      const max     = Math.max(...numericValues);

      const resultValue =
        metric === 'average' ? average :
        metric === 'count'   ? count   :
        total; // default: total

      return {
        found:         true,
        category,
        metric,
        result:        resultValue,
        total,
        average:       Math.round(average * 100) / 100,
        count,
        min,
        max,
        record_count:  count,
      };
    }

    // ── report ────────────────────────────────────────────────────────────────
    // Delegates to the universal generate_report handler with any template hint
    // from the tool config baked into the params.
    case 'report': {
      const reportParams = {
        report_type:       config.report_type || params.report_type || 'summary',
        executive_summary: params.executive_summary || `Automated ${display_name} report`,
        sections:          params.sections || [],
        next_steps:        params.next_steps || [],
        disclaimer:        params.disclaimer || '',
        // Pass template hint as a section header if provided
        ...(config.template_hint && !params.sections?.length && {
          sections: [{ heading: config.template_hint, content: 'See analysis above.' }],
        }),
      };

      return generateReport(reportParams, context);
    }

    // ── escalate ──────────────────────────────────────────────────────────────
    // Delegates to the universal request_specialist handler with urgency
    // and department from the tool config.
    case 'escalate': {
      const escalateParams = {
        reason:          params.reason || `Client triggered "${display_name}"`,
        urgency:         config.urgency || params.urgency || 'medium',
        context_summary: params.context_summary || '',
        // Surface department in the context summary if configured
        ...(config.department && {
          context_summary: `Department: ${config.department}. ${params.context_summary || ''}`.trim(),
        }),
      };

      return requestSpecialist(escalateParams, context);
    }

    // ── connect ───────────────────────────────────────────────────────────────
    // Fires an outbound webhook to the tenant's own system.
    // The tenant configures the URL, method, and any static headers.
    // Claude's tool input is forwarded as the request body.
    case 'connect': {
      const {
        webhook_url,
        method           = 'POST',
        headers          = {},
        auth_type,        // 'bearer' | 'api_key' | 'none'
        auth_token,       // the secret value
        auth_header_name, // e.g. 'X-Api-Key' (only when auth_type='api_key')
      } = config;

      if (!webhook_url) {
        return {
          error: `Tool "${display_name}" is misconfigured — no webhook_url set.`,
          success: false,
        };
      }

      // SSRF guard (defence-in-depth) — rows created before the route-level
      // validation may still hold an internal URL, so re-check here before
      // ever issuing the request.
      const urlErr = validateWebhookUrl(webhook_url);
      if (urlErr) {
        console.warn(`[CustomTool] connect "${name}" blocked: ${urlErr}`);
        return {
          success: false,
          error:   `Tool "${display_name}" has an invalid webhook URL: ${urlErr}`,
        };
      }

      // Build auth headers from config
      const authHeaders = {};
      if (auth_type === 'bearer' && auth_token) {
        authHeaders['Authorization'] = `Bearer ${auth_token}`;
      } else if (auth_type === 'api_key' && auth_token && auth_header_name) {
        authHeaders[auth_header_name] = auth_token;
      }

      try {
        const response = await fetch(webhook_url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...headers,
            ...authHeaders,
          },
          body: method !== 'GET' ? JSON.stringify({
            tool_name:   name,
            customer_id: context.customerId,
            tenant_id:   context.tenantId,
            params,
          }) : undefined,
          // Do NOT follow redirects: validateWebhookUrl is a string-only check,
          // so a public URL that 3xx-redirects to an internal host (e.g. the
          // cloud-metadata endpoint) would otherwise bypass the guard. This is
          // the only outbound surface that returns the response body to the
          // caller, so an unchecked redirect is a real exfiltration path.
          redirect: 'manual',
          signal: AbortSignal.timeout(8000), // 8-second timeout
        });

        // With redirect:'manual', a 3xx surfaces as an opaque redirect
        // (type 'opaqueredirect', status 0). Reject it instead of returning
        // a body the caller could use to probe internal infrastructure.
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
          console.warn(`[CustomTool] connect "${name}" blocked redirect from ${webhook_url}`);
          return {
            success: false,
            error:   `Webhook endpoint attempted a redirect, which is blocked for security reasons.`,
          };
        }

        const responseText = await response.text();
        let responseData;
        try { responseData = JSON.parse(responseText); } catch (_) { responseData = responseText; }

        return {
          success:     response.ok,
          status:      response.status,
          data:        responseData,
        };
      } catch (err) {
        console.error(`[CustomTool] connect "${name}" webhook failed:`, err.message);
        return {
          success: false,
          error:   `Could not reach ${webhook_url}: ${err.message}`,
        };
      }
    }

    // ── unknown ───────────────────────────────────────────────────────────────
    default:
      console.warn(`[CustomTool] Unknown tool_type: "${tool_type}" for tool "${name}"`);
      return {
        error: `Tool "${display_name}" has an unrecognised type: "${tool_type}".`,
      };
  }
}

module.exports = { handleCustomTool };
