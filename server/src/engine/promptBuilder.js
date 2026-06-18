/**
 * SHENMAY AI — Prompt Builder Engine (Industry-Agnostic)
 *
 * Assembles the system prompt that gives the agent its identity and knowledge.
 * This is the core of Shenmay: before every conversation, the agent reads its
 * Soul (who it is), Memory (what it knows), and Customer Data (domain-specific records).
 *
 * Works across any vertical: retirement, healthcare, insurance, etc.
 * The tenant's vertical_config drives domain-specific terminology and framing.
 *
 * Input shapes
 * ------------
 *
 * @typedef {Object} PromptTenant
 * @property {string}  [name]
 * @property {string}  [agent_name]
 * @property {string}  [website_url]
 * @property {Object}  [vertical_config]     Domain terminology + framing rules.
 * @property {Object}  [compliance_config]   Legacy disclaimer/restricted-topic config.
 * @property {Object}  [onboarding_config]
 *
 * @typedef {Object} PromptCustomer
 * @property {Object}  [soul_file]           Agent persona / identity (decrypted).
 * @property {Object}  [memory_file]         Long-term memory blob (decrypted).
 * @property {string}  [onboarding_status]
 * @property {string[]} [onboarding_categories_completed]
 *
 * @typedef {Object} PromptDataRecord
 * @property {string}  [category]
 * @property {string}  [data_category]       Legacy alias of category.
 * @property {string}  [label]
 * @property {string}  [value]
 * @property {string}  [secondary_value]
 * @property {string}  [value_type]
 * @property {Object}  [metadata]
 *
 * @typedef {Object} PromptProduct
 * @property {string}  name
 * @property {string}  [description]
 * @property {string}  [category]
 * @property {string}  [price_info]
 * @property {string}  [notes]
 *
 * @typedef {Object} BuildPromptInput
 * @property {PromptTenant}         tenant
 * @property {PromptCustomer}       customer
 * @property {PromptDataRecord[]}   [customerData]
 * @property {PromptProduct[]}      [products]
 * @property {string}               [currentDate]    YYYY-MM-DD; defaults to today.
 * @property {string|null}          [handbackNote]   Optional advisor handoff note.
 * @property {boolean}              [widgetGreeted]  True when the widget already
 *                                                   greeted — suppress re-greet.
 */

/**
 * Assemble the full system prompt for one chat turn.
 *
 * All keys in `input` are shallow — only `tenant` and `customer` are
 * required. Accepts additional undocumented fields without error so the
 * caller (widget.js / chat.js) can pass extras without breaking.
 *
 * @param   {BuildPromptInput} input
 * @returns {string} The system prompt ready to hand to Claude.
 * @throws  {TypeError} When `tenant` or `customer` is missing.
 */
function buildSystemPrompt({ tenant, customer, customerData, products, currentDate, handbackNote, widgetGreeted }) {
  // Fail fast: missing tenant/customer was previously a TypeError deep inside
  // buildIdentityBlock (`Cannot read properties of undefined (reading 'base_identity')`).
  // Catch it at the boundary with a clear message instead.
  if (!tenant || typeof tenant !== 'object') {
    throw new TypeError('buildSystemPrompt: `tenant` is required');
  }
  if (!customer || typeof customer !== 'object') {
    throw new TypeError('buildSystemPrompt: `customer` is required');
  }

  const date = currentDate || new Date().toISOString().split('T')[0];
  const soul = customer.soul_file || {};
  const memory = customer.memory_file || {};
  const verticalConfig = tenant.vertical_config || {};

  const productsBlock = buildProductsBlock(products, tenant);
  const websiteBlock  = buildWebsiteBlock(tenant);
  const handbackBlock = buildHandbackNoteBlock(handbackNote);

  return `${buildIdentityBlock(soul, tenant, verticalConfig)}

${buildComplianceBlock(soul, tenant)}

${productsBlock ? productsBlock + '\n' : ''}${websiteBlock ? websiteBlock + '\n' : ''}${buildCommunicationBlock(soul)}

${buildCustomerNameBlock(soul, memory)}

${handbackBlock ? handbackBlock + '\n' : ''}${buildConversationHistoryBlock(memory)}

${buildMemoryBlock(memory)}

${buildCustomerDataBlock(memory, customerData, verticalConfig)}

${buildLifePlanBlock(memory)}

${buildAgentNotesBlock(memory)}

${buildSessionRulesBlock(customer, tenant, date, widgetGreeted)}`;
}


// --- Prompt sections ---

function buildIdentityBlock(soul, tenant, verticalConfig) {
  const identity = soul.base_identity || {};
  const rolDescription = verticalConfig.agent_role_description
    || identity.role
    || 'Personalized assistant providing educational and informational guidance.';
  const framingRules = verticalConfig.framing_rules
    || 'You provide EDUCATIONAL and INFORMATIONAL guidance only. Frame everything as suggestions and considerations, never prescriptive advice.';

  // Customer-given name: check agent_nickname (set by widget UI) first,
  // then fall back to base_identity.customer_given_name (legacy/seed data)
  const customerGivenName = soul.agent_nickname || identity.customer_given_name;
  const displayName = customerGivenName || identity.agent_name || tenant.agent_name;

  let nameBlock = '';
  if (customerGivenName) {
    nameBlock = `Your name is "${customerGivenName}" — this is the name this customer chose for you. ALWAYS use this name when referring to yourself. This personal name is part of your bond with this customer. NEVER ask the customer to give you a name — they already did.`;
  } else {
    nameBlock = `Your name is "${identity.agent_name || tenant.agent_name}". The customer has not given you a personal nickname yet, but DO NOT ask them to name you — the widget interface handles naming separately. Simply use your current name naturally.`;
  }

  return `## YOUR IDENTITY

You are "${displayName}", a personalized ${verticalConfig.domain_label || 'AI'} assistant for ${identity.organization || tenant.name}.

${nameBlock}

Your role: ${rolDescription}

You are NOT a generic chatbot. You are a persistent, personalized agent for this specific ${verticalConfig.customer_label || 'customer'}. You remember everything about them. You pick up where you left off. You know their concerns, their goals, their situation. Every interaction should feel like talking to someone who truly knows them.

CRITICAL: ${framingRules}`;
}


function buildComplianceBlock(soul, tenant) {
  // New schema: soul.compliance (generated by soulGenerator)
  // Legacy fallback: tenant.compliance_config (hand-configured)
  const soulCompliance  = (soul && soul.compliance) || {};
  const tenantConfig    = tenant.compliance_config || {};
  const advisorLabel    = (tenant.vertical_config || {}).advisor_label || 'advisor';

  // Soul-generated compliance takes precedence over tenant config
  const disclaimers = soulCompliance.required_disclaimers || tenantConfig.disclaimers || [];
  const restricted  = soulCompliance.restricted_topics   || tenantConfig.restricted_topics || [];
  const escalation  = soulCompliance.escalation_triggers || tenantConfig.escalation_triggers || [];

  const disclaimerLines = disclaimers.length
    ? disclaimers.map(d => `- ${d}`).join('\n')
    : '- Always clarify you are an AI assistant, not a licensed professional';

  const restrictedLines = restricted.length
    ? restricted.map(t => `- ${t}`).join('\n')
    : `- Specific advice requiring professional licensure — refer to their ${advisorLabel}`;

  const escalationLines = escalation.length
    ? escalation.map(t => `- ${t}`).join('\n')
    : '- Any expression of distress or urgent need';

  return `## COMPLIANCE RULES (NON-NEGOTIABLE)

Required disclaimers (include naturally when giving information):
${disclaimerLines}

Topics you CANNOT provide guidance on (refer to human ${advisorLabel}):
${restrictedLines}

Automatic escalation triggers (flag for human review):
${escalationLines}`;
}


function buildCommunicationBlock(soul) {
  // New schema: soul.communication_style (generated by soulGenerator)
  // Legacy fallback: soul.communication_profile + soul.behavioral_rules
  const comm    = soul.communication_style || soul.communication_profile || {};
  const isNew   = !!soul.communication_style;

  // key_principles (new) or personality_rules (legacy)
  const principles = isNew
    ? (comm.key_principles || [])
    : (soul.behavioral_rules?.personality_rules || []);
  const rules = principles.length
    ? principles.map(r => `- ${r}`).join('\n')
    : '- Be warm, clear, and professional';

  // pacing (new) or pace (legacy)
  const pace = comm.pacing || comm.pace || 'moderate';

  // New-schema extras
  const avoidPhrases     = comm.avoid_phrases     || [];
  const preferredPhrases = comm.preferred_phrases || [];

  const avoidBlock = avoidPhrases.length
    ? `\nPhrases to AVOID:\n${avoidPhrases.map(p => `- "${p}"`).join('\n')}` : '';

  const preferBlock = preferredPhrases.length
    ? `\nPreferred phrases/expressions:\n${preferredPhrases.map(p => `- "${p}"`).join('\n')}` : '';

  return `## HOW TO COMMUNICATE WITH THIS CUSTOMER

Tone: ${comm.tone || 'warm & reassuring'}
Complexity Level: ${comm.complexity_level || 3}/5
Pace: ${pace}
Emotional Awareness: ${comm.emotional_awareness || 'high'}
Language: ${comm.language || 'plain English'}

${comm.notes ? `Special notes: ${comm.notes}\n` : ''}Communication rules:
${rules}
${avoidBlock}${preferBlock}

Framing approach: ${soul.behavioral_rules?.framing || 'Always frame guidance as educational, never prescriptive.'}`;
}


function buildMemoryBlock(memory) {
  const profile = memory.personal_profile || {};
  const family = profile.family || {};

  let familyText = '';
  if (family.marital_status) {
    familyText += `Marital Status: ${family.marital_status}\n`;
  }
  if (family.spouse) {
    familyText += `Spouse: ${family.spouse.name} (age ${family.spouse.age})${family.spouse.health_notes ? ` — ${family.spouse.health_notes}` : ''}\n`;
  }
  if (family.late_spouse) {
    familyText += `Late Spouse: ${family.late_spouse.name} (passed ${family.late_spouse.passed})${family.late_spouse.notes ? ` — ${family.late_spouse.notes}` : ''}\n`;
  }
  if (family.children) {
    familyText += `Children:\n${family.children.map(c =>
      `  - ${c.name} (age ${c.age}), ${c.location}${c.children ? ` — grandchildren: ${c.children.join(', ')}` : ''}${c.notes ? ` — ${c.notes}` : ''}`
    ).join('\n')}\n`;
  }

  return `## WHO THIS CUSTOMER IS

Name: ${profile.name || 'Unknown'}
Age: ${profile.age || 'Unknown'}
Location: ${profile.location || 'Unknown'}
Career: ${profile.career || 'Not specified'}
Tech Comfort: ${profile.tech_comfort || 'moderate'}
Communication Preference: ${profile.communication_preference || 'Not specified'}

Family:
${familyText}`;
}


function buildCustomerDataBlock(memory, customerData, verticalConfig) {
  const snapshot = memory.financial_snapshot || memory.data_snapshot || {};
  const sectionTitle = verticalConfig.terminology?.data_section_title || 'Customer Data';
  const primaryLabel = verticalConfig.terminology?.primary_value_label || 'Value';
  const monthlyLabel = verticalConfig.terminology?.monthly_value_label || 'Monthly';

  let dataText = '';
  if (customerData && customerData.length > 0) {
    // Group by category — support new schema (category) and legacy (data_category)
    const grouped = {};
    customerData.forEach(record => {
      const cat = record.category || record.data_category || 'general';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(record);
    });

    dataText = Object.entries(grouped).map(([category, records]) => {
      const lines = records.map(r => {
        // New schema: value_type / legacy: data_type
        const typeLabel = r.value_type || r.data_type || '';
        let line = `- ${r.label}${typeLabel ? ` (${typeLabel})` : ''}`;

        // New schema: value (TEXT) / legacy: value_primary (numeric)
        const primaryRaw = r.value ?? r.value_primary;
        if (primaryRaw !== null && primaryRaw !== undefined) {
          const num = parseFloat(String(primaryRaw).replace(/[^0-9.-]/g, ''));
          line += !isNaN(num) ? `: $${num.toLocaleString()}` : `: ${primaryRaw}`;
        }

        // New schema: secondary_value (TEXT) / legacy: value_monthly (numeric)
        const monthlyRaw = r.secondary_value ?? r.value_monthly;
        if (monthlyRaw !== null && monthlyRaw !== undefined) {
          const num = parseFloat(String(monthlyRaw).replace(/[^0-9.-]/g, ''));
          line += !isNaN(num) ? ` / $${num.toLocaleString()}/month` : ` / ${monthlyRaw}/month`;
        }

        // New schema: institution lives in metadata; legacy: top-level column
        const institution = r.institution || r.metadata?.institution;
        if (institution) line += ` at ${institution}`;

        return line;
      }).join('\n');
      return `### ${category.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}\n${lines}`;
    }).join('\n\n');
  }

  // Build summary section from memory snapshot if available
  let summaryText = '';
  if (snapshot.total_estimated_assets || snapshot.total_value) {
    summaryText += `Total Estimated ${primaryLabel}: $${(snapshot.total_estimated_assets || snapshot.total_value || 0).toLocaleString()}\n`;
  }
  if (snapshot.monthly_income) {
    summaryText += `${monthlyLabel} Income: $${(snapshot.monthly_income || 0).toLocaleString()}\n`;
  }
  if (snapshot.monthly_expenses) {
    summaryText += `${monthlyLabel} Expenses: $${(snapshot.monthly_expenses || 0).toLocaleString()}\n`;
  }
  if (snapshot.income_gap_notes) summaryText += `Note: ${snapshot.income_gap_notes}\n`;
  if (snapshot.surplus_notes) summaryText += `Note: ${snapshot.surplus_notes}\n`;

  return `## ${sectionTitle.toUpperCase()} (Last Updated: ${snapshot.last_updated || 'Unknown'})

${summaryText}
${dataText}

IMPORTANT: You know this data. Reference it naturally in conversation — don't ask the customer to re-state what you already know. But always verify if something may have changed since your last update.`;
}


function buildLifePlanBlock(memory) {
  const plan = memory.life_plan || memory.goals || {};

  // Generic approach: iterate over all plan sections dynamically
  const sections = [];

  for (const [key, value] of Object.entries(plan)) {
    if (typeof value === 'object' && value !== null) {
      const title = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      const details = Object.entries(value)
        .map(([k, v]) => {
          const label = k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          const display = Array.isArray(v) ? v.join(', ') : String(v);
          return `${label}: ${display}`;
        })
        .join('\n');
      sections.push(`### ${title}\n${details}`);
    } else if (value) {
      const title = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      sections.push(`### ${title}\n${value}`);
    }
  }

  if (sections.length === 0) {
    return `## GOALS & PLANS\n\nNo specific goals or plans have been discussed yet. Explore this during conversation.`;
  }

  return `## GOALS & PLANS — What Matters to This Customer

${sections.join('\n\n')}

IMPORTANT: Reference their goals naturally. Connect what you know about their situation to what they care about most. This is what makes you different from a generic chatbot.`;
}


function buildConversationHistoryBlock(memory) {
  const history = memory.conversation_history || [];

  if (history.length === 0) {
    return `## CONVERSATION HISTORY\n\nThis is your first conversation with this customer. Focus on making them comfortable and beginning the onboarding process.`;
  }

  // Cap to last 5 sessions to keep prompt size manageable.
  const HISTORY_WINDOW = 5;
  const totalSessions  = history.length;
  const recent         = history.slice(-HISTORY_WINDOW);
  const olderCount     = totalSessions - recent.length;

  // Collect ALL open action items across recent sessions — these are your follow-up obligations
  const openActionItems = [];
  recent.forEach(session => {
    (session.action_items || []).forEach(item => {
      if (item && item.trim()) openActionItems.push({ item: item.trim(), date: session.date });
    });
  });

  // Key insights from the most recent session worth highlighting
  const lastSession     = recent[recent.length - 1];
  const recentInsights  = lastSession.key_insights || [];

  const summaries = recent.map(session => {
    let text = `### Session ${session.session} — ${session.date} (${session.type || 'regular'}, tone: ${session.emotional_tone || 'neutral'})
${session.summary || '(No summary recorded)'}`;
    if (session.key_insights?.length > 0) {
      text += `\nKey insights: ${session.key_insights.join('; ')}`;
    }
    if (session.action_items?.length > 0) {
      text += `\nAction items noted: ${session.action_items.join('; ')}`;
    }
    if (session.flags && session.flags.length > 0) {
      text += `\nFlags: ${session.flags.map(f => `[${f.type}] ${f.description}`).join('; ')}`;
    }
    return text;
  }).join('\n\n');

  const olderNote = olderCount > 0
    ? `\n(${olderCount} earlier session${olderCount > 1 ? 's' : ''} not shown — focus on the most recent ${HISTORY_WINDOW}.)\n`
    : '';

  // Surface open follow-ups prominently — this is what makes the customer feel remembered
  const followUpBlock = openActionItems.length > 0
    ? `\n## OPEN FOLLOW-UPS — CHECK IN ON THESE

These were noted as action items in recent sessions. The customer said they'd do these — ask naturally whether they happened:
${openActionItems.map(({ item, date }) => `- "${item}" (noted ${date})`).join('\n')}

Weave check-ins into conversation naturally. Don't make it feel like a checklist audit.\n`
    : '';

  return `${followUpBlock}## CONVERSATION HISTORY (${totalSessions} total sessions — showing last ${recent.length})
${olderNote}
${summaries}

IMPORTANT: You remember all of this. Reference previous conversations naturally. Never ask the customer to repeat something you already know. The emotional_tone field tells you how they were feeling — let that shape how you open.`;
}


function buildProductsBlock(products, tenant) {
  if (!products || products.length === 0) return '';

  const lines = products.map(p => {
    let line = `- **${p.name}**`;
    if (p.category)    line += ` [${p.category}]`;
    if (p.description) line += `: ${p.description}`;
    if (p.price_info)  line += ` (${p.price_info})`;
    if (p.notes)       line += ` — ${p.notes}`;
    return line;
  }).join('\n');

  return `## WHAT ${(tenant.name || 'WE').toUpperCase()} OFFERS

The following products and services are available. Be knowledgeable about them and answer questions accurately. Never invent products not listed here.

${lines}

PRODUCT AWARENESS GUIDELINES:
- You are a knowledgeable representative of ${tenant.name || 'the organization'}. Your purpose is to help customers discover, understand, and take action on what ${tenant.name || 'the organization'} offers. Stay focused on that mission.
- When the customer's message relates to any of the above offerings, answer helpfully and naturally connect it back to the relevant product or service — don't force it, let it flow from the conversation.
- If the topic is only loosely related, be warm but brief, then bring it back: acknowledge what they said in one sentence, then pivot to the most relevant offering.
- NEVER be pushy or salesy. You're a knowledgeable guide, not a salesperson.
- Keep responses concise — 2-4 sentences per turn unless the customer asks for detail.

HANDLING OFF-TOPIC OR IRRELEVANT MESSAGES:
If a customer sends a message that has NO connection to ${tenant.name || 'the organization'} or its products and services — for example, random questions, unrelated advice requests, or nonsensical content — do NOT engage with the off-topic content. Instead, respond briefly and redirect directly. Example:
  "That's a bit outside what I'm here for! I'm [name], ${tenant.name || "the organization"}'s assistant — I can help you with [brief summary of what they offer]. What can I help you with today?"
Be direct but friendly. One redirect is enough — don't lecture or explain at length.

CRITICAL — HOW TO END EVERY RESPONSE:
Every response MUST close with something actionable that moves the customer toward one of the offerings above — not an open-ended personal question about their feelings, background, or opinions. Good closings:
  ✓ "Would you like to [sign up / register / attend / learn more about] [specific offering]?"
  ✓ "Is [specific product or service] something you'd want to explore?"
  ✓ Direct the customer to the website or contact if you don't have the specific info they need.
Closings to avoid:
  ✗ "What draws you most to [topic]?" — chitchat, no action
  ✗ "Have you ever done [thing] before?" — chitchat, no action
  ✗ "How does that make you feel?" — chitchat, no action
The only exception: one clarifying question is fine if you genuinely need more info before you can point them to the right offering.`;
}


function buildWebsiteBlock(tenant) {
  const url = tenant.website_url;
  if (!url) return '';

  return `## WEBSITE REFERENCE

${tenant.name || 'The organization'} has a website at: ${url}

IMPORTANT: Your product/service knowledge comes from the list above. However, the website may contain additional information you're not aware of (such as media links, event details, or resources). If a customer asks about something that seems related to ${tenant.name || 'the organization'} but isn't in your product list:
- Acknowledge that it might exist on their website
- Say something like: "I don't have that specific information in my records, but you can check ${url} for more details — they may have exactly what you're looking for!"
- NEVER make up information about what's on the website. Only reference it as a fallback.`;
}


function buildHandbackNoteBlock(note) {
  if (!note || !note.trim()) return '';
  return `## ADVISOR HANDOFF NOTE

The human advisor who was just handling this conversation left you the following context before returning control to you:

"${note.trim()}"

Read this carefully. It may explain what was discussed, what was promised, or what the customer's current concern is. Do NOT mention this note to the customer — simply use it to inform your response.`;
}


function buildAgentNotesBlock(memory) {
  const notes = memory.agent_notes || [];

  if (notes.length === 0) return '';

  return `## YOUR PERSONAL NOTES ABOUT THIS CUSTOMER

${notes.map(n => `- ${n}`).join('\n')}

These are observations you've made. Use them to communicate more effectively.`;
}


function buildCustomerNameBlock(soul, memory) {
  const customerName = soul.customer_name || memory?.personal_profile?.name || null;
  const history      = memory?.conversation_history || [];
  const hasHistory   = history.length > 0;

  if (!customerName) {
    return `## CUSTOMER IDENTITY\n\nThe customer's name is not yet known. They will introduce themselves — when they do, use their name naturally going forward. Do NOT ask for their name; the widget UI already collects it.`;
  }

  // agent_nickname being set means the customer has already gone through the widget naming flow —
  // they are definitively a returning user even if no session summaries have been written yet.
  const agentNicknameSet = !!(soul && soul.agent_nickname);

  if (!hasHistory && !agentNicknameSet) {
    return `## CUSTOMER IDENTITY

The customer's name is **${customerName}**. Always address them by this name.

This is their first conversation. Open warmly: "Hello ${customerName}, I'm [your name]! It's great to meet you. How can I help you today?" — then follow their lead.`;
  }

  // Customer has just completed the naming flow (agentNicknameSet) but has no session history yet.
  // The widget UI already greeted them as part of naming completion — do NOT greet again.
  if (!hasHistory) {
    return `## CUSTOMER IDENTITY

The customer's name is **${customerName}**. Always address them by this name.

IMPORTANT: The widget has already greeted this customer and introduced you just moments ago. Do NOT open with another greeting ("Hey!", "Good to hear from you", "Hi again", etc.) — that would feel robotic and repetitive. Simply respond naturally to what they actually said, as if you are mid-conversation. Follow their lead.`;
  }

  const lastSession   = history[history.length - 1];
  const actionItems   = lastSession.action_items || [];
  const openAction    = actionItems.find(a => a && a.trim());
  const emotionalTone = lastSession.emotional_tone || 'neutral';
  const summary       = lastSession.summary || '';
  const topics        = lastSession.topics || [];

  // Build the richest, most specific greeting hook possible
  let greetingInstruction;
  if (openAction) {
    // Action items are the gold standard — they're specific and show you were paying attention
    greetingInstruction = `Open naturally with something like: "Hey ${customerName}! Good to hear from you. Last time you mentioned you'd ${openAction.toLowerCase().replace(/^to /, '')} — did you get a chance to do that?" Adapt the phrasing to sound natural, not scripted.`;
  } else if (summary.length > 30) {
    const hook = summary.slice(0, 100).replace(/\.\s*$/, '').toLowerCase();
    greetingInstruction = `Open warmly with a reference to last time, e.g. "Welcome back, ${customerName}! Last time we were going over ${hook} — want to continue or is there something new on your mind?"`;
  } else if (topics.length > 0) {
    const topicHint = topics[0].replace(/_/g, ' ');
    greetingInstruction = `Open with: "Welcome back, ${customerName}! Great to see you. Last time we were talking about ${topicHint} — want to pick up there, or something new today?"`;
  } else {
    greetingInstruction = `Open warmly: "Hello ${customerName}! Great to see you again. What's on your mind today?"`;
  }

  const toneNote = (emotionalTone === 'anxious' || emotionalTone === 'confused')
    ? `\nNOTE: This customer left the last session feeling ${emotionalTone}. Be especially warm, patient, and reassuring right from your opening.`
    : (emotionalTone === 'satisfied' || emotionalTone === 'positive')
    ? `\nNOTE: This customer left the last session in a good mood. Match that warm energy.`
    : '';

  return `## CUSTOMER IDENTITY

The customer's name is **${customerName}**. Always address them by this name.

This is a RETURNING customer (${history.length} prior session${history.length !== 1 ? 's' : ''}).${toneNote}

${greetingInstruction}

After your opening, follow the conversation naturally. Never ask for their name — you already know it.`;
}


function buildSessionRulesBlock(customer, tenant, date, widgetGreeted) {
  const isOnboarding = customer.onboarding_status !== 'complete';
  const completedCategories = customer.onboarding_categories_completed || [];

  // Get onboarding categories from tenant config (industry-specific)
  const onboardingConfig = tenant.onboarding_config || {};
  const allCategories = onboardingConfig.categories || [];
  const remaining = allCategories.filter(c => !completedCategories.includes(c));

  let onboardingInstructions = '';
  if (isOnboarding && remaining.length > 0) {
    // Agent naming is handled by the widget UI, not by the LLM
    const otherRemaining = remaining.filter(c => c !== 'agent_naming');

    const namingNote = `
NOTE: Agent naming is handled by the widget interface before the chat begins. Do NOT ask the customer to name you during conversation.`;

    onboardingInstructions = `
## ONBOARDING — CATEGORIES STILL TO COVER

This customer's onboarding is not complete. You still need to cover:
${otherRemaining.map(c => `- ${c.replace(/_/g, ' ')}`).join('\n')}

Already covered: ${completedCategories.map(c => c.replace(/_/g, ' ')).join(', ') || 'None'}
${namingNote}
APPROACH: Cover these naturally through conversation. Do NOT present them as a checklist. Ask open-ended questions that flow from one topic to the next. If the customer wants to end early, that's fine — pick up remaining topics next time.`;
  }

  const advisorLabel = (tenant.vertical_config || {}).advisor_label || 'advisor';

  // When the widget already showed an opening greeting, tell the AI not to repeat it.
  const noGreetNote = widgetGreeted
    ? `\nCRITICAL: The widget has already displayed an opening greeting to this visitor. Do NOT start your response with a greeting ("Hi", "Hello", "Hey", etc.) or a self-introduction. Go straight to answering what they asked.\n`
    : '';

  return `## SESSION RULES

Today's date: ${date}
Session type: ${isOnboarding ? 'Onboarding (in progress)' : 'Regular conversation'}
${noGreetNote}

${onboardingInstructions}

End-of-session behavior:
- When the customer indicates they're done, summarize key points discussed
- Note any action items or follow-ups
- If any flags were triggered during the session, they will be automatically reviewed by the human ${advisorLabel}

Remember: You are this customer's persistent assistant. Be warm, be knowledgeable, be helpful. Make every interaction feel like picking up a conversation with someone who truly knows them.

RESPONSE LENGTH: Keep replies SHORT and conversational — 2-4 sentences is ideal for most turns. Only give longer answers when the customer asks a detailed question. Avoid walls of text, excessive bullet points, or repeating what the customer already said. Be natural, not encyclopedic.`;
}


module.exports = {
  buildSystemPrompt,
  buildIdentityBlock,
  buildComplianceBlock,
  buildCommunicationBlock,
  buildMemoryBlock,
  buildProductsBlock,
  buildWebsiteBlock,
  buildCustomerDataBlock,
  buildLifePlanBlock,
  buildConversationHistoryBlock,
  buildAgentNotesBlock,
  buildSessionRulesBlock
};
