> **HISTORICAL — frozen, no longer maintained.** Point-in-time artifact kept for reference only.
> For current state see [`docs/SESSION_NOTES.md`](../SESSION_NOTES.md). Archived 2026-06-18 (audit M3/T15).

---

# Shenmay AI — Lovable Build Prompts
## pontensolutions.com Tenant Portal

Paste these prompts into Lovable **in order**, one at a time. Wait for each one to finish before pasting the next. Each prompt builds on the previous one.

**Important context:** pontensolutions.com is a multi-product site. All Shenmay AI pages live under the `/nomii` path so they don't interfere with other products on the site. The existing homepage and other product pages are untouched.

**Route structure:**
```
pontensolutions.com/nomii              ← Shenmay AI marketing/landing page
pontensolutions.com/nomii/signup       ← Sign up
pontensolutions.com/nomii/login        ← Log in
pontensolutions.com/nomii/terms        ← Terms of Service (public)
pontensolutions.com/nomii/onboarding   ← Setup wizard (new tenants)
pontensolutions.com/nomii/dashboard    ← Overview
pontensolutions.com/nomii/dashboard/conversations
pontensolutions.com/nomii/dashboard/customers
pontensolutions.com/nomii/dashboard/concerns
pontensolutions.com/nomii/dashboard/settings
```

**Base API URL:** `https://api.pontensolutions.com`
**Auth:** Portal JWT stored in `localStorage` as `nomii_portal_token`

---

## PROMPT 1 — API Client & Auth Foundation

Paste this first. It sets up the shared API layer everything else uses.

---

> I'm adding a new product section to this site called Shenmay AI. All Shenmay AI pages will live under the `/nomii` path. Please create the following foundation files — do not modify any existing pages or routes.
>
> Create `src/lib/nomiiApi.js` that exports a configured API client for the Shenmay AI backend at `https://api.pontensolutions.com`.
>
> Export the following functions:
>
> **Auth helpers:**
> - `getToken()` — returns `localStorage.getItem('nomii_portal_token')`
> - `setToken(token)` — saves to localStorage under key `nomii_portal_token`
> - `clearToken()` — removes `nomii_portal_token` from localStorage
> - `isLoggedIn()` — returns true if `nomii_portal_token` exists in localStorage
>
> **API request helper:**
> - `apiRequest(method, path, body?)` — makes a fetch call to `https://api.pontensolutions.com` + path, sets `Content-Type: application/json`, adds `Authorization: Bearer <token>` header if a token exists, returns the parsed JSON response. If the response status is 401, call `clearToken()` and redirect to `/nomii/login`. Throw an error with the response's `error` field if the status is not ok.
>
> **Auth endpoints:**
> - `register(email, password, firstName, lastName, companyName, vertical)` — POST `/api/onboard/register`
> - `login(email, password)` — POST `/api/onboard/login`
>
> **Portal endpoints:**
> - `getMe()` — GET `/api/portal/me`
> - `updateCompany(data)` — PUT `/api/portal/company`
> - `getProducts()` — GET `/api/portal/products`
> - `addProduct(data)` — POST `/api/portal/products`
> - `updateProduct(id, data)` — PUT `/api/portal/products/${id}`
> - `deleteProduct(id)` — DELETE `/api/portal/products/${id}`
> - `uploadProductsCsv(csvString)` — POST `/api/portal/products/upload` with body `{ csv: csvString }`
> - `getCustomers(page, limit)` — GET `/api/portal/customers?page=${page}&limit=${limit}`
> - `getCustomer(id)` — GET `/api/portal/customers/${id}`
> - `uploadCustomersCsv(csvString)` — POST `/api/portal/customers/upload` with body `{ csv: csvString }`
> - `deleteCustomer(id)` — DELETE `/api/portal/customers/${id}`
> - `getDashboard()` — GET `/api/portal/dashboard`
> - `getConversations(page, status)` — GET `/api/portal/conversations?page=${page}&status=${status || ''}`
> - `getConversation(id)` — GET `/api/portal/conversations/${id}`
> - `getConcerns()` — GET `/api/portal/concerns`
>
> Also create `src/contexts/NomiiAuthContext.jsx` (use a Shenmay-specific name to avoid conflicts with any existing auth context on the site) that:
> - Stores `nomiiUser` (admin object) and `nomiiTenant` (tenant object) state
> - On mount, if `isLoggedIn()`, calls `getMe()` and populates state; if the call fails, calls `clearToken()` and redirects to `/nomii/login`
> - Exports `useNomiiAuth()` hook
> - Exports `NomiiAuthProvider` component
>
> Finally, create `src/components/nomii/NomiiProtectedRoute.jsx` — a route guard that checks `isLoggedIn()`. If not logged in, redirects to `/nomii/login`. Wrap all `/nomii/onboarding` and `/nomii/dashboard/*` routes with this guard.
>
> Add all `/nomii/*` routes to the router. Do not change any existing routes.

---

## PROMPT 2 — Shenmay AI Landing Page, Auth Pages & Terms of Service

> Add the following pages under the `/nomii` path. Do not modify any existing pages.
>
> **Landing page (`/nomii`):**
> A clean marketing page for Shenmay AI specifically. Header with the Shenmay AI logo/wordmark and tagline: "Add a personalized AI agent to your website in minutes." Two CTA buttons: "Get Started Free" (→ `/nomii/signup`) and "Sign In" (→ `/nomii/login`). Below the header, three feature cards: "Easy Setup — Install with one script tag or our WordPress plugin", "Knows Your Customers — Your agent learns each user's preferences and history", "You Stay in Control — Monitor every conversation from your dashboard." Keep it simple and professional. Use a navy and gold color scheme (`#1E3A5F` / `#C9A84C`).
>
> **Terms of Service page (`/nomii/terms`):**
> A clean, readable legal page. Title: "Shenmay AI — Terms of Service". Include the following sections as plain prose under headings:
>
> *1. Service Description* — Shenmay AI is a platform provided by Ponten Solutions that enables businesses ("Tenants") to deploy personalized AI agents on their websites. Shenmay AI acts as a data processor on behalf of Tenants.
>
> *2. Tenant Responsibilities* — By using Shenmay AI, you confirm that: (a) you have obtained all necessary rights, consents, and permissions to upload your customers' personal data to Shenmay AI; (b) your use of Shenmay AI complies with all applicable privacy laws including GDPR, CCPA, and any other relevant regulations in your jurisdiction; (c) you will notify your customers that their interactions with your website's AI agent are processed by Shenmay AI on your behalf.
>
> *3. Data Processing* — Shenmay AI stores customer data (email, name, and any data you upload) solely to power the AI agent service on your behalf. We do not sell your customer data to third parties. Data is stored securely and access is restricted to your tenant account.
>
> *4. Data Deletion* — You may request deletion of any customer record at any time from your Shenmay AI dashboard. Upon deletion, all personally identifiable information is anonymised. You may also request full account deletion by contacting support@pontensolutions.com.
>
> *5. Limitation of Liability* — Shenmay AI is provided "as is." Ponten Solutions is not liable for any damages arising from your use of the service or from your customers' use of AI agents deployed through Shenmay AI.
>
> *6. Changes* — We may update these terms. Continued use of Shenmay AI after changes are posted constitutes acceptance.
>
> *Last updated: March 2026.* Footer: "Questions? Contact support@pontensolutions.com"
>
> **Login page (`/nomii/login`):**
> Centered card on a light gray background. "Shenmay AI" heading at the top. Fields: Email, Password. "Sign in to Shenmay AI" button — calls `login(email, password)` from `nomiiApi.js`. On success: calls `setToken(token)`, stores tenant/admin in `NomiiAuthContext`, redirects to `/nomii/dashboard`. On error: shows the error message in red below the form. Link: "Don't have an account? Get started →" links to `/nomii/signup`.
>
> **Sign up page (`/nomii/signup`):**
> Same card layout. "Get started with Shenmay AI" heading. Fields: First Name, Last Name, Email, Password (min 8 characters, show strength hint), Company Name, Industry (dropdown: Financial, Retirement, Ministry, Healthcare, Insurance, Education, E-commerce, Other).
>
> Below the fields, before the submit button, add two required checkboxes:
>
> Checkbox 1 — must be checked to submit: "I agree to the Shenmay AI [Terms of Service](/nomii/terms) (opens in new tab)."
>
> Checkbox 2 — must be checked to submit: "I confirm that I have obtained the necessary rights and consents to upload my customers' personal data to Shenmay AI, and that my use complies with applicable privacy laws (GDPR, CCPA, etc.)."
>
> Pass `tos_accepted: true` in the registration API call only when both boxes are checked. If either is unchecked and the user clicks submit, show an inline error: "Please accept the terms and confirm your data rights before continuing."
>
> "Create my Shenmay account" button — calls `register(...)` from `nomiiApi.js` with `tos_accepted: true`. On success: calls `setToken(token)`, stores tenant/admin in `NomiiAuthContext`, redirects to `/nomii/onboarding`. On error: shows error in red. Link: "Already have an account? Sign in →" links to `/nomii/login`.

---

## PROMPT 3 — Onboarding Wizard

> Add the onboarding wizard at `/nomii/onboarding`. This route is protected by `NomiiProtectedRoute`. Do not modify any existing pages.
>
> **Layout:** Split view. Left sidebar (~260px) shows the 5 steps as a vertical list with icons. Each step shows: step number, name, and status (gray circle = not started, green checkmark = complete). Read completion status from `nomiiTenant.onboarding_steps` in `NomiiAuthContext`. Main content area on the right renders the active step. Shenmay AI logo at the top of the sidebar. "Back to dashboard →" link at the bottom of the sidebar (visible once at least one step is complete).
>
> **Step 1 — Company Profile:**
> Form fields: Company Name (pre-filled from `nomiiTenant.name`), Agent Name ("What should your AI agent be called?" — pre-filled from `nomiiTenant.agent_name`), Industry (dropdown, pre-filled), Primary Color (color picker, pre-filled from `nomiiTenant.primary_color`), Secondary Color (color picker), Website URL, Company Description (textarea — placeholder: "Describe what your company does. This helps your AI agent represent you accurately to your customers."). "Save & Continue" button calls `updateCompany(data)`. On success, mark step 1 complete locally and advance to step 2. Show a success toast.
>
> **Step 2 — Products & Services:**
> Heading: "What does your company offer?" Subheading: "Your AI agent will use this to answer customer questions about your products and services." Show a table of existing products (loaded from `getProducts()` on mount). Table columns: Name, Category, Description (truncated), Actions (Edit, Delete). Above table: "Add Product" button opens an inline slide-down form with fields: Name (required), Description, Category, Price/Cost Info, Notes. Save calls `addProduct(data)`, refreshes the list. Below the table: dashed upload area — "Or import from CSV". File input that reads the file as text and calls `uploadProductsCsv(csvString)`. Show result: "X products imported." Include a small "Download template" text link that triggers a browser download of: `name,description,category,price_info,notes` as `nomii-products-template.csv`. Step 2 is marked complete when at least one product exists. "Continue" button advances to step 3.
>
> **Step 3 — Customer Data:**
> Heading: "Upload your customer list (optional)"
> Subheading: "If you upload your existing customers, your AI agent can recognize them the moment they log into your website. You can always do this later."
>
> Show a light yellow info box before the upload area with this text: "⚠️ Only upload data you have the right to share. By uploading customer data you confirmed during sign-up that you have obtained the necessary consents. Do not upload sensitive information such as passwords, social security numbers, financial account numbers, or medical records."
>
> Show a dashed drop zone for CSV upload. When a file is selected, read it as text, show a preview table of the first 3 rows (with headers), and a "Confirm Import" button that calls `uploadCustomersCsv(csvString)`. Show result: "X customers added, Y updated." Include a "Download template" link that downloads: `email,first_name,last_name,phone,account_id,notes` as `nomii-customers-template.csv`. Below everything: "Skip for now →" link that marks this step complete and advances. "Continue" button also advances.
>
> **Step 4 — Install Widget:**
> Heading: "Add Shenmay AI to your website" Show the widget key in a styled read-only box with a "Copy key" button.
>
> Below it, a platform selector with icon tabs. Show instructions for each:
>
> **WordPress** (show first — most common): "Install our WordPress plugin — no coding needed." Download button linking to `https://shenmay.ai/downloads/shenmay-wordpress-plugin.zip` (the legacy `.../nomii-wordpress-plugin.zip` URL 301-redirects until 2026-10-20). Steps: 1. Download the plugin. 2. Go to WordPress Admin → Plugins → Add New → Upload Plugin. 3. Select the downloaded zip and click Install Now. 4. Activate the plugin. 5. Go to Settings → Shenmay AI, paste your Widget Key, and save.
>
> **Webflow**: "Go to Site Settings → Custom Code → Footer Code. Paste this before `</body>`:" Show copy-able code snippet.
>
> **Squarespace**: "Go to Settings → Advanced → Code Injection → Footer. Paste this:" Show snippet.
>
> **Wix**: "Go to Settings → Custom Code → Add Code (bottom of page). Paste this:" Show snippet.
>
> **Shopify**: "Go to Online Store → Themes → Edit Code → `theme.liquid`. Find `</body>` and paste this just above it:" Show snippet.
>
> **React / Next.js / Lovable**: "In your authenticated layout component, add this inside a `useEffect`:" Show the React code block.
>
> **Other**: "Paste this snippet before `</body>` on every page where you want the widget:" Show snippet.
>
> The embed snippet for all non-React platforms (replace WIDGET_KEY with the actual tenant widget key):
> ```html
> <script
>   src="https://api.pontensolutions.com/embed.js"
>   data-widget-key="WIDGET_KEY"
>   data-user-email="LOGGED_IN_USER_EMAIL"
>   data-user-name="LOGGED_IN_USER_NAME"
>   async>
> </script>
> ```
> Note below the snippet: "Replace `LOGGED_IN_USER_EMAIL` and `LOGGED_IN_USER_NAME` with the actual values from your site's login session."
>
> **Verification status box** below all instructions: poll `getMe()` every 5 seconds while this step is open. While `nomiiTenant.widget_verified` is false: gray box "Waiting to detect your widget... Load any page on your website after installing to verify." Once true: animated green box with checkmark "Widget connected! Your agent is live on your website." Step auto-marks complete. Stop polling once verified.
>
> **Step 5 — Test Your Agent:**
> Heading: "Send a test message to your agent." Embed an iframe: `https://api.pontensolutions.com/widget.html?key=WIDGET_KEY&email=preview@test.com&name=Preview+User` — styled at 400px wide, 500px tall, centered, with a subtle shadow. Below the iframe: "This is exactly what your customers will see." Big "Go to my dashboard →" button navigates to `/nomii/dashboard` and marks step 5 complete.
>
> When all 5 steps are complete, show a full-width green banner at the top: "🎉 Setup complete! Your Shenmay AI agent is live." with a "Go to Dashboard" button.

---

## PROMPT 4 — Dashboard Layout

> Add the Shenmay AI dashboard layout that wraps all `/nomii/dashboard/*` pages. All dashboard routes are protected by `NomiiProtectedRoute`. Do not modify any existing pages or layouts.
>
> Create `src/layouts/NomiiDashboardLayout.jsx`.
>
> **Left sidebar** (fixed, 240px, dark navy `#1E3A5F`):
> - "Shenmay AI" wordmark at the top in white
> - Below it: tenant name in small gold text, agent name in smaller gray text
> - Nav links with icons (white text, gold highlight on active):
>   - Overview (home icon) → `/nomii/dashboard`
>   - Conversations (chat bubble icon) → `/nomii/dashboard/conversations`
>   - Customers (people icon) → `/nomii/dashboard/customers`
>   - Concerns (alert triangle icon) → `/nomii/dashboard/concerns` — show a red badge with count if `openConcerns > 0`
>   - Settings (gear icon) → `/nomii/dashboard/settings`
> - Divider line near the bottom
> - Admin name + email in small white text
> - "Sign out" button that calls `clearToken()`, clears `NomiiAuthContext`, and redirects to `/nomii/login`
>
> **Main content area**: white background, top bar with current page title, scrollable content below.
>
> On layout mount, call `getConcerns()` to get the concerns count for the badge. Refresh every 60 seconds.

---

## PROMPT 5 — Dashboard Overview (`/nomii/dashboard`)

> Add the Shenmay AI overview page at `/nomii/dashboard`. Use `NomiiDashboardLayout`. Do not modify existing pages.
>
> On mount, call `getDashboard()` and display:
>
> **Warning banner** (shown only if `nomiiTenant.widget_verified` is false): yellow banner at top — "Your widget hasn't been detected yet. Complete your setup →" linking to `/nomii/onboarding`.
>
> **Stats row** — 4 cards:
> - Total Conversations (speech bubble icon, blue)
> - Active Customers — last 30 days (person icon, green)
> - Total Customers (people icon, gray)
> - Open Concerns (alert icon, red if > 0 otherwise gray)
>
> **Recent Conversations table** below stats:
> Columns: Customer, Last Message (truncated to 70 chars, italic), Time (relative, e.g. "2 hours ago"). Clicking a row navigates to `/nomii/dashboard/conversations/:id`. Show up to 10 rows. "View all conversations →" link below the table.
>
> Show a loading skeleton while fetching. Show a centered error state with a retry button if the call fails.

---

## PROMPT 6 — Conversations (`/nomii/dashboard/conversations`)

> Add conversations pages. Use `NomiiDashboardLayout`. Do not modify existing pages.
>
> **List page (`/nomii/dashboard/conversations`):**
> Status filter tabs: All / Active / Ended / Escalated. Clicking filters the list.
> Table columns: Customer (name + email in small text below), Status (pill badge: blue=Active, gray=Ended, red=Escalated), Messages (count), Last Message (truncated, 60 chars), Started (relative date). Clicking a row navigates to the detail page. Paginate 25 per page with Previous / Next and "Showing X–Y of Z" count.
>
> **Detail page (`/nomii/dashboard/conversations/:id`):**
> On mount call `getConversation(id)`. Show:
> - Top bar: back button "← All conversations", customer name + email, status badge
> - Full message thread as a chat UI: customer messages on the left (light gray bubble), agent messages on the right (bubble in `nomiiTenant.primary_color` with white text). Each message shows the role label and timestamp.
> - If the conversation status is `escalated`, show a red banner: "This conversation was escalated for human review."

---

## PROMPT 7 — Customers (`/nomii/dashboard/customers`)

> Add customers pages. Use `NomiiDashboardLayout`. Do not modify existing pages.
>
> **List page (`/nomii/dashboard/customers`):**
> Table columns: Name, Email, Status (onboarding_status pill badge), Last Interaction (relative time, "Never" if null), Joined. Clicking a row goes to the detail page. Paginate 25 per page.
>
> **Detail page (`/nomii/dashboard/customers/:id`):**
> On mount call `getCustomer(id)`. Three-section layout:
>
> **Header card**: Avatar (initials), full name, email, status badge, last interaction date.
>
> **Soul & Memory card**: Two columns side by side.
> Left — Soul: if `soul_file` has content, show Agent's name for this customer (`soul_file.base_identity.customer_given_name` or "Not yet named"), communication tone, complexity level. If empty: "No soul file yet — this customer hasn't had a conversation."
> Right — Memory: if `memory_file` has content, show personal profile summary (name, age, location) and any goals. If empty: "No memory yet."
>
> **Conversations card**: List of this customer's conversations — load from `/nomii/dashboard/conversations` filtered mentally, or link to "View conversations with this customer →" linking to the conversations page.
>
> **Danger Zone card** at the bottom (subtle red border): "Delete Customer Data — If this customer has requested to be forgotten under GDPR or CCPA, you can anonymise and remove all their personal data here. This cannot be undone." Red "Delete customer data" button. When clicked, show a confirmation modal: "Are you sure? This will permanently erase all personal information for this customer. Their conversation history will be retained but anonymised." Confirm button calls `deleteCustomer(id)` (which calls `DELETE /api/portal/customers/:id`). On success, redirect to `/nomii/dashboard/customers` and show a toast "Customer data has been anonymised and removed."

---

## PROMPT 8 — Concerns (`/nomii/dashboard/concerns`)

> Add the concerns page at `/nomii/dashboard/concerns`. Use `NomiiDashboardLayout`. Do not modify existing pages.
>
> On mount call `getConcerns()`.
>
> If empty: centered illustration with a green checkmark and "No open concerns — everything looks good."
>
> If concerns exist: red summary banner "You have X open concerns that need attention." Then a table: Customer (name + email), Last Message (truncated, 80 chars), Escalated On (date). Clicking a row navigates to the full conversation at `/nomii/dashboard/conversations/:id`.

---

## PROMPT 9 — Settings (`/nomii/dashboard/settings`)

> Add the settings page at `/nomii/dashboard/settings`. Use `NomiiDashboardLayout`. Do not modify existing pages.
>
> Three sections on the page, separated by dividers:
>
> **Company Profile:**
> Pre-filled form using `nomiiTenant` from context: Company Name, Agent Name, Industry (dropdown), Primary Color (color picker), Secondary Color (color picker), Website URL, Company Description (textarea). "Save changes" button calls `updateCompany(data)`, shows success toast "Settings saved", updates `nomiiTenant` in context.
>
> **Widget:**
> "Your Widget Key" — read-only input showing the widget key with a "Copy" button. Below it: "Verification status" — green "Connected" badge if `nomiiTenant.widget_verified`, yellow "Not yet detected" if not (with a link "→ Installation guide" to `/nomii/onboarding#step4`). Below that: "Your embed snippet" in a styled code block with a "Copy snippet" button.
>
> **Products & Services:**
> Full product management UI (same as wizard Step 2): table of products with edit/delete, Add Product form, CSV upload. This is the post-onboarding management view.

---

## PROMPT 10 — AI Product Import (Step 2 Enhancement)

Two parts — paste them in order.

### PROMPT 10a — Add API functions to nomiiApi.js

> In `src/lib/nomiiApi.js`, add the following two functions to the existing exports. Do not change anything else.
>
> - `aiSuggestProducts(urlOrDescription)` — POST `/api/portal/products/ai-suggest` with body `{ url: urlOrDescription }` if the value starts with `http` or looks like a domain (contains a `.`), otherwise with body `{ description: urlOrDescription }`. Returns `{ proposed: [...], count: N }` or `{ error, fallback }`.
>
> - `bulkSaveProducts(products)` — POST `/api/portal/products/bulk-save` with body `{ products }`. Returns `{ ok: true, saved: N }`.

---

### PROMPT 10b — Update Step 2 (Products & Services) in the onboarding wizard

> Update the **Products & Services** step in the onboarding wizard (`/nomii/onboarding`, Step 2). Do not change any other steps or pages.
>
> **Replace the current step content with this new layout:**
>
> **Heading:** "What does your company offer?"
> **Subheading:** "Your AI agent will use this to answer customer questions about your products and services."
>
> ---
>
> **Section 1 — AI Import (show this first, most prominent)**
>
> A card with a subtle blue/indigo border and a ✨ or sparkle icon in the header. Title: "Import with AI". Subtitle: "Enter your website URL and we'll scan it automatically. Or paste a description — we'll do the rest."
>
> A single text input, full width. Placeholder: "yourcompany.com  —  or describe what you sell in a sentence or two"
>
> A button: "✨ Extract with AI" — calls `aiSuggestProducts(inputValue)` from `nomiiApi.js`. Show a loading spinner with text "Scanning..." while waiting (disable the button).
>
> **On success (proposed.length > 0):** Hide the input card and show a **preview section**:
> - Green success banner: "Found X products/services. Review them below and uncheck any you don't want."
> - A list of the proposed products. Each row shows: checkbox (checked by default), product name (bold), description (gray, truncated), category pill, price info if present. User can uncheck items they don't want.
> - A "Save X selected products →" button that calls `bulkSaveProducts(checkedItems)`. On success: refresh the product list, show a toast "X products added!", return to the normal step view.
> - A "Start over" text link that clears the preview and returns to the input card.
>
> **On error with `fallback: true`:** Show a yellow warning box: "We couldn't extract much from that site — it may use JavaScript to load content. Try pasting a description of what you offer in the box below." Keep the input focused so the user can type a description instead.
>
> **On other error:** Show the error message in red below the button. Keep the input.
>
> ---
>
> **Section 2 — Existing products table** (unchanged from current implementation)
>
> Show below the AI import card. Table with current products (from `getProducts()`), Edit/Delete actions, and "Add Product" button for manual entry.
>
> ---
>
> **Section 3 — CSV import** (unchanged, keep as-is at the bottom)
>
> ---
>
> **Continue button** at the bottom — enabled when at least one product exists OR the user explicitly clicks "Skip this step →".

---

## PROMPT 11 — Smart Customer Import (Step 3 Enhancement)

Two parts — paste them in order.

### PROMPT 11a — Add API functions to nomiiApi.js

> In `src/lib/nomiiApi.js`, add the following two functions to the existing exports. Do not change anything else.
>
> - `aiMapCustomerCsv(headers, sampleRows)` — POST `/api/portal/customers/ai-map` with body `{ headers, sample_rows: sampleRows }`. Returns `{ mapping: { "CSV Column": "field_name", ... } }`.
>
> - `uploadCustomersCsvMapped(csvString, mapping)` — POST `/api/portal/customers/upload` with body `{ csv: csvString, mapping }`. Returns `{ ok, inserted, updated, errors }`.

---

### PROMPT 11b — Update Step 3 (Customer Data) in the onboarding wizard

> Update the **Customer Data** step in the onboarding wizard (`/nomii/onboarding`, Step 3). Do not change any other steps or pages.
>
> **Replace the current step content with this new layout:**
>
> **Heading:** "Import your customers"
> **Subheading:** "Upload any customer list you already have — a spreadsheet export, CRM dump, or email list. We'll figure out the columns automatically."
>
> Show the legal warning box first (keep existing): ⚠️ "Only upload data you have the right to share..."
>
> ---
>
> **The import flow has 3 stages — show one at a time:**
>
> **Stage 1 — File drop (default view):**
> A dashed drop zone. "Drop your CSV here or click to browse". File input (CSV only). Below: "Skip for now →" link.
>
> When a file is selected: read it as text, parse the headers and first 5 rows client-side (split on newlines and commas for preview purposes — don't need full CSV parsing). Call `aiMapCustomerCsv(headers, sampleRows)`. Show a loading state: "Analysing your file..." while waiting. Advance to Stage 2.
>
> **Stage 2 — Mapping review:**
> Heading: "Here's how we'll map your columns." Subheading: "Adjust anything that looks wrong."
>
> Show a clean table with 3 columns: **Your column** (the original CSV header), **Sample data** (first value from that column), **Maps to** (a dropdown selector).
>
> The dropdown options are: Email (required), First Name, Last Name, Customer/Platform ID, Notes, — Skip this column —
>
> Pre-select each dropdown based on the mapping returned by `aiMapCustomerCsv`. Highlight the Email row in blue — it's required.
>
> Below the table: a "Confirm & Import →" button. Disabled if no column is mapped to Email. When clicked, build the confirmed mapping object `{ "CSV Column": "field_name" }` using the dropdown values (email, first_name, last_name, external_id, notes, skip), then call `uploadCustomersCsvMapped(csvText, confirmedMapping)`. Show loading: "Importing...". Advance to Stage 3.
>
> Also show a "← Choose a different file" link that goes back to Stage 1.
>
> **Stage 3 — Success:**
> Green checkmark. "X customers imported (Y updated)." If there were row errors, show them in a collapsed "Show issues" details element. Two buttons: "Import another file" (back to Stage 1) and "Continue →" (advance to Step 4).
>
> ---
>
> Keep the "Skip for now →" link visible in Stages 1 and 2.

---

## PROMPT 12 — Email Verification Flow

Two parts — paste in order.

### PROMPT 12a — Add API functions to nomiiApi.js

> In `src/lib/nomiiApi.js`, make these changes. Do not change anything else.
>
> 1. Update the `register` function to include `newsletter_opt_in: boolean` in the request body.
>
> 2. The `register` function should now handle two possible success responses:
>    - `{ pending_verification: true, email }` → return it as-is (email verification required)
>    - `{ token, tenant, admin }` → store token in localStorage as `nomii_portal_token` and return it (legacy — may occur in dev)
>
> 3. Add `verifyEmail(token)` — GET `/api/onboard/verify/:token`. On success stores the JWT in `localStorage` as `nomii_portal_token` and returns `{ token, tenant, admin }`.
>
> 4. Add `resendVerification(email)` — POST `/api/onboard/resend-verification` with body `{ email }`. Returns `{ ok, message }`.
>
> 5. The `login` function should handle an extra error case: if the response is `{ error: ..., code: 'email_unverified', email }`, return it as a structured error object so the UI can show a resend link.

---

### PROMPT 12b — Update signup page + add verify-email page

> Make these two changes. Do not change any other pages.
>
> **Part A — Signup page (`/nomii/signup`):**
>
> 1. Add a newsletter opt-in checkbox near the bottom of the form, above the submit button:
>    - Label: "I'd like to receive product updates and occasional tips from Shenmay AI"
>    - Default: unchecked
>    - Pass its value as `newsletter_opt_in` when calling `register()`
>
> 2. After a successful registration that returns `{ pending_verification: true }`, instead of navigating to onboarding, show an inline "Check your email" state on the same page:
>    - A large email icon or checkmark graphic
>    - Heading: "Check your email"
>    - Body: "We've sent a verification link to **{email}**. Click the link in the email to activate your account."
>    - A "Resend verification email" link that calls `resendVerification(email)` and shows "Sent!" confirmation
>    - A "← Back to login" link
>
> 3. On the signup form, if the API returns `{ code: 'company_name_taken' }`, show the error inline under the company name field: "This company name is already registered. Please use a different name."
>
> **Part B — Add email verification page at `/nomii/verify-email`:**
>
> Create a new page at this route. It should:
>
> 1. On mount, read the `?token=` query parameter from the URL.
> 2. If no token, show an error: "Invalid verification link."
> 3. Call `verifyEmail(token)` immediately (show a loading spinner while waiting).
> 4. On success: show a success screen — checkmark icon, heading "Email verified!", body "Your account is ready. Let's set up your AI agent." — then after 2 seconds automatically redirect to `/nomii/onboarding`.
> 5. On error (expired/invalid token): show error message with a form to enter their email and a "Send new link" button that calls `resendVerification(email)`.

---

## PROMPT 13 — Onboarding Persistence + User Identity

> Make these changes to the onboarding wizard at `/nomii/onboarding`. Do not change other pages.
>
> **1. Persistent user identity in the header:**
>
> Add a small user identity pill in the top-right of the onboarding page header/nav bar. It should show:
> - A small avatar circle with the user's initials (from `admin.first_name` + `admin.last_name`)
> - The user's email address or name next to it
> - Clicking it shows a small dropdown with just: "Dashboard" and "Log out"
>
> Get the user data by calling `getMe()` from `nomiiApi.js` on page load and storing it in component state.
>
> **2. Step data persistence (survive page refresh):**
>
> On mount of the onboarding wizard, call `getMe()` and use the response to pre-populate already-saved data:
>
> - Step 1 (Company Info): pre-fill Company Name (`tenant.name`), Description (`tenant.company_description`), Website (`tenant.website_url`), Industry (`tenant.vertical`), Agent Name (`tenant.agent_name`), Primary Color (`tenant.primary_color`)
> - Step 2 (Products): if `onboarding_steps.products` is true, show a "✓ Products saved" summary with a link to re-edit
> - Step 3 (Customers): if `onboarding_steps.customers` is true, show a "✓ Customers imported" summary
> - Step 4 (Widget): pre-load the widget key and show it — don't require re-entry
>
> **3. Step 4 — Add "Continue →" button after widget connects:**
>
> Currently Step 4 has no way to advance after the widget verification turns green. Fix this:
> - Poll `getMe()` every 5 seconds while on Step 4
> - When `tenant.widget_verified` is `true`, show a green "✓ Widget connected!" banner AND a "Continue to next step →" button
> - Clicking the button advances to Step 5

---

## PROMPT 14 — Dashboard Overview Fix

> Update the dashboard overview page at `/nomii/dashboard`. Do not change the sidebar or navigation.
>
> The stats come from `GET /api/portal/dashboard` which returns:
> ```json
> {
>   "stats": {
>     "total_conversations": 12,
>     "active_customers_30d": 5,
>     "total_customers": 10,
>     "total_messages": 87,
>     "open_concerns": 2
>   },
>   "recent_conversations": [
>     {
>       "id": "uuid",
>       "status": "active",
>       "customer_display_name": "Sarah",
>       "email": "sarah@example.com",
>       "last_message": "Thanks for the help!",
>       "last_message_at": "2026-03-12T10:00:00Z",
>       "message_count": 7
>     }
>   ]
> }
> ```
>
> 1. Display the 5 stats cards using the correct field names above. The cards should be: Total Conversations, Customers (30 days), Total Customers, Total Messages, Open Concerns.
>
> 2. Recent conversations list: use `customer_display_name` (not `first_name`/`last_name`) as the display name. If `customer_display_name` is missing, fall back to `email`.
>
> 3. Make each conversation row in the recent list clickable — clicking navigates to `/nomii/dashboard/conversations/{id}`.
>
> 4. Auto-refresh the stats every 15 seconds using `setInterval`.

---

## PROMPT 15 — Conversations Page Revamp

> Completely replace the conversations page at `/nomii/dashboard/conversations` and add a conversation detail view. Keep the sidebar and navigation.
>
> **Conversations list page (`/nomii/dashboard/conversations`):**
>
> The data comes from `GET /api/portal/conversations?status=&page=1&limit=25` which returns:
> ```json
> {
>   "conversations": [
>     {
>       "id": "uuid",
>       "status": "active",
>       "customer_display_name": "Sarah",
>       "customer_id": "uuid",
>       "email": "user@example.com",
>       "message_count": 7,
>       "last_message": "Thanks for the help!",
>       "last_message_at": "2026-03-12T10:00:00Z",
>       "created_at": "2026-03-12T09:00:00Z"
>     }
>   ],
>   "total": 45,
>   "page": 1,
>   "limit": 25
> }
> ```
>
> Show a clean support-ticket-style table with these columns:
> - **Customer** — `customer_display_name`, smaller text below showing `email`
> - **Last Message** — truncated preview of `last_message` (max 80 chars), greyed out if empty
> - **Messages** — `message_count` badge
> - **Last Active** — relative time from `last_message_at` (e.g. "2 hours ago")
> - **Status** — colour-coded pill: `active` = green, `escalated` = red, `ended` = grey
>
> Above the table: three filter tabs — **All** / **Active** / **Escalated** — that filter by status. Pass `?status=active` or `?status=escalated` to the API (All passes no status param).
>
> Each row is clickable and navigates to `/nomii/dashboard/conversations/{id}`.
>
> Auto-refresh every 15 seconds.
>
> **Conversation detail page (`/nomii/dashboard/conversations/:id`):**
>
> Load from `GET /api/portal/conversations/:id`.
>
> Show:
> - Header: customer display name, email, status pill, "← Back to conversations" link
> - A scrollable message thread — each message as a chat bubble (agent messages on the left with agent name, customer messages on the right)
> - Message timestamps
> - If status is `active`, show a note: "This conversation is ongoing"

---

## PROMPT 16 — Customers Page Revamp

> Completely replace the customers page at `/nomii/dashboard/customers`. Keep the sidebar and navigation.
>
> The data comes from `GET /api/portal/customers?page=1&limit=50` which returns:
> ```json
> {
>   "customers": [
>     {
>       "id": "uuid",
>       "display_name": "Sarah",
>       "email": "sarah@example.com",
>       "onboarding_status": "complete",
>       "last_interaction_at": "2026-03-12T10:00:00Z",
>       "idle_minutes": 12,
>       "created_at": "2026-03-01T00:00:00Z"
>     }
>   ],
>   "total": 10
> }
> ```
>
> Show a clean table ordered by most recent activity (the API already returns them in this order). Columns:
> - **Name** — `display_name`, smaller text showing `email` below
> - **Last Active** — relative time from `last_interaction_at` (e.g. "12 minutes ago"), or "Never" if null
> - **Status** — small pill showing `idle_minutes`:
>   - No `last_interaction_at` → grey "No activity"
>   - `idle_minutes` ≤ 5 → green pulsing dot + "Active now"
>   - `idle_minutes` ≤ 60 → yellow "Idle X min"
>   - Otherwise → grey "Idle Xh Ym" or relative time
> - **Onboarding** — `onboarding_status` pill: `complete` = green, `in_progress` = yellow, `pending` = grey
>
> Each row is clickable and navigates to `/nomii/dashboard/customers/{id}`. (The customer detail page already exists — just make sure the route works.)
>
> Auto-refresh the list every 15 seconds.

---

## PROMPT 17 — Settings Page Fix

> Update the settings page at `/nomii/dashboard/settings`. Keep the sidebar and navigation.
>
> On mount, call `getMe()` from `nomiiApi.js` and pre-populate ALL form fields from the response:
>
> **Company section:**
> - Company Name (`tenant.name`) — text field
> - Industry/Vertical (`tenant.vertical`) — select dropdown with options: financial, retirement, ministry, healthcare, insurance, education, ecommerce, other
> - Company Description (`tenant.company_description`) — textarea
> - Website URL (`tenant.website_url`) — text field
> - Agent Name (`tenant.agent_name`) — text field
> - Primary Color (`tenant.primary_color`) — colour picker input
>
> Save via `PUT /api/portal/company` with the updated values. Show a "Saved ✓" confirmation.
>
> **Products & Services section:**
> Load products from `GET /api/portal/products`. Show them as a list of cards with Edit and Delete buttons. Each card shows name, category (if set), and description. Include an "Add product" button at the top. Editing opens an inline form.

---

## PROMPT 18 — Profile Page

> Add a new profile page at `/nomii/dashboard/profile`. Add it to the sidebar navigation under a "Profile" link. Keep the existing sidebar and navigation.
>
> On mount, call `getMe()` and populate the fields.
>
> Show two sections:
>
> **Personal Information:**
> - First Name — text field (`admin.first_name`)
> - Last Name — text field (`admin.last_name`)
> - Email — read-only text (cannot be changed)
> - Role — read-only badge (`admin.role`)
> - Save button → `PUT /api/portal/admin/profile` with `{ first_name, last_name }`
>
> **Change Password:**
> - Current Password — password field
> - New Password — password field (min 8 characters, show strength indicator)
> - Confirm New Password — password field
> - Save button → `PUT /api/portal/admin/password` with `{ current_password, new_password }`
> - Show clear success/error feedback

---

## PROMPT 19 — Login: handle unverified email error

> Two changes needed — both in `src/lib/nomiiApi.js` and the login page.
>
> **1. Update `apiRequest` in `nomiiApi.js`**
>
> When the response status is not ok, instead of just throwing `new Error(data.error)`, also attach the `code` field from the response so callers can detect specific error types:
>
> ```js
> const err = new Error(data.error || 'Request failed');
> err.code = data.code || null;
> throw err;
> ```
>
> Also add this export to `nomiiApi.js`:
> - `resendVerification(email)` — POST `/api/onboard/resend-verification` with body `{ email }` (no auth header needed)
>
> **2. Update the Login page**
>
> After a failed login attempt, check if `err.code === 'email_unverified'`. If so, instead of showing the generic error message, replace the error area with this specific UI:
>
> - A yellow/amber warning box (distinct from the generic red error style) containing:
>   - Text: "Your email address hasn't been verified yet. Please check your inbox for a verification link."
>   - A button below the text: "Resend verification email"
> - When "Resend verification email" is clicked:
>   - Disable the button and show a loading state
>   - Call `resendVerification(email)` using the email the user typed in the form
>   - On success: replace the button with a green confirmation message "Verification email sent — please check your inbox."
>   - On error: show "Couldn't send the email. Please try again." and re-enable the button
>
> All other login errors (wrong password, account not found, etc.) continue to show the existing generic red error style unchanged.

---

## After All Prompts — Re-onboard HFTN

Once all pages are live in Lovable, test the full flow:

1. Go to `pontensolutions.com/nomii/signup`
2. Sign up: email `ajaces@gmail.com`, company `Hope for This Nation`, vertical `Ministry`, agent name `Beacon`, primary color `#4A2C8F`
3. Walk through the wizard — add ministry description, programs/services, skip customer upload
4. On Step 4, select **React / Next.js / Lovable** tab and follow the instructions to update `hub.hopeforthisnation.com` with the new widget key
5. Watch Step 4 turn green automatically
6. Send a test message in Step 5
7. Hit the dashboard

**Note:** This creates a new HFTN tenant. The old manually-seeded one (`22222222-...`) still exists in the DB and can be deleted later once the new one is confirmed working.

---

## PROMPT 20 — Onboarding Persistence Fix

> The onboarding wizard at `/nomii/onboarding` currently resets to Step 1 on hard refresh. Fix this so the wizard always resumes at the correct step.
>
> **How it should work:**
>
> On component mount, call `getMe()` from `nomiiApi.js`. The response includes `tenant.onboarding_steps` — a JSON object like `{ "company": true, "products": true }`.
>
> Use this to determine the current step:
> - If `company` is not `true` → start at Step 1
> - If `company` is `true` but `products` is not → start at Step 2
> - If `products` is `true` but `customers` is not → start at Step 3
> - If `customers` is `true` but `widget` is not → start at Step 4
> - If `widget` is `true` → onboarding complete, redirect to `/nomii/dashboard`
>
> Also restore form field values on mount from the same `getMe()` response:
> - Step 1: pre-fill company name, industry, description, website, agent name, primary colour from `tenant.*`
> - Step 2: products are already loaded from `GET /api/portal/products`
> - Step 3: customers table is already loaded from `GET /api/portal/customers`
> - Step 4: widget key is pre-filled from `tenant.widget_key`
>
> Show a loading spinner while `getMe()` is in flight so there's no flash of Step 1 before the resume.

---

## PROMPT 21 — Remove Step 5 from Onboarding

> Remove Step 5 (the live widget test step) from the onboarding wizard entirely.
>
> The wizard should now have only 4 steps:
> 1. Company Profile
> 2. Products & Services
> 3. Import Customers (optional)
> 4. Add the Widget
>
> After Step 4's widget detection fires (the `widget_verified_at` timestamp is set on the backend when the widget calls home), show a completion screen with:
> - A success icon ✓
> - Heading: "You're all set!"
> - Subtext: "Your AI agent is live. Head to your dashboard to see conversations and manage your customers."
> - A single button: "Go to Dashboard →" that navigates to `/nomii/dashboard`
>
> Update the step indicator at the top to show 4 steps (not 5).

---

## PROMPT 22 — Conversations UI: Messenger Style

> Redesign the Conversations page at `/nomii/dashboard/conversations` to use a two-panel Facebook Messenger layout.
>
> **Left panel (conversation list, ~320px wide, full height, scrollable):**
> - Each row shows:
>   - Customer name (or "Anonymous Visitor" if `is_anonymous: true`)
>   - Last message preview (truncated to 1 line)
>   - Relative timestamp (e.g. "2m ago", "Yesterday", "Mon")
>   - Unread dot or message count badge if applicable
> - Active/selected conversation is highlighted with a soft background
> - Clicking a row loads that conversation in the right panel without a page reload
> - Load from `GET /api/portal/conversations` — the response now includes `is_anonymous` per conversation
>
> **Right panel (conversation thread, fills remaining width):**
> - Header shows customer name + status badge
> - Messages displayed in a chat bubble style:
>   - Customer messages on the LEFT (light grey bubble)
>   - Agent messages on the RIGHT (primary colour bubble)
>   - Timestamp shown below each message
> - Load from `GET /api/portal/conversations/:id`
> - "No conversation selected" placeholder when nothing is chosen
>
> **Behaviour:**
> - On page load, auto-select the most recent conversation
> - Refresh the conversation list every 30 seconds
> - Keep the existing sidebar and top navigation
>
> Remove the old table/card layout entirely and replace with this two-panel design.

---

## PROMPT 23 — Customers Page: Clean Cards

> Redesign the Customers page at `/nomii/dashboard/customers` to use a clean card-grid layout.
>
> **Cards:**
> Each customer is displayed as a card containing:
> - Large initials avatar (first letter of display name) in a circle with the primary brand colour
> - Display name (from `customer.display_name`)
> - Email address in smaller muted text
> - Status pill: `complete` = green, `in_progress` = amber, `pending` = grey
> - Idle time (e.g. "Active 5 min ago" or "Last seen 3 days ago") — only show if `idle_minutes` is not null
>
> Cards should sit in a responsive grid (3 columns on desktop, 2 on tablet, 1 on mobile).
>
> Clicking a card navigates to `/nomii/dashboard/customers/{id}`.
>
> **Above the grid:**
> - A search bar that filters cards client-side by name or email
> - A "Total customers" count
>
> **Pagination:**
> Load 25 customers per page from `GET /api/portal/customers`. Show simple "Previous / Next" buttons at the bottom if there are more than 25.
>
> Auto-refresh the list every 30 seconds.

---

## PROMPT 24 — Settings: Fix Company Description

> The Company Description field on the Settings page (`/nomii/dashboard/settings`) is not pre-populating even though the value is saved in the database.
>
> The fix: when `getMe()` is called on mount, explicitly set the company description textarea's value to `tenant.company_description`. Make sure this happens AFTER the component has rendered (use `useEffect` with the fetched data as a dependency, not just on mount).
>
> Also ensure the save button sends the current textarea value (not a stale cached state). The field maps to `company_description` in the `PUT /api/portal/company` body.
>
> While you're here, double-check that ALL settings fields pre-populate correctly:
> - Company Name → `tenant.name`
> - Industry → `tenant.vertical`
> - Company Description → `tenant.company_description`
> - Website URL → `tenant.website_url`
> - Agent Name → `tenant.agent_name`
> - Primary Color → `tenant.primary_color`

---

## PROMPT 25 — Dashboard: Anonymous Visitors Section

> Update the Dashboard at `/nomii/dashboard` to show a new "Anonymous Visitors" stat and section.
>
> **Stats bar update:**
> The `GET /api/portal/dashboard` response now includes `stats.anonymous_visitors` (count of unlogged widget visitors). Add it as a new stat card in the stats bar:
> - Label: "Anonymous Visitors"
> - Icon: a person silhouette with a question mark, or a ghost icon
> - Value: `stats.anonymous_visitors`
>
> **Recent conversations update:**
> The `recent_conversations` array now includes `is_anonymous: true` for visitors who chatted without logging in. For these rows, show "Anonymous Visitor" as the customer name instead of the email address.
>
> **New "Unlogged Visitors" tab (optional, add only if fits naturally in the layout):**
> If the dashboard has tabs or sections, add an "Unlogged Visitors" section that fetches from `GET /api/portal/visitors`. This endpoint returns anonymous visitor records with `display_name: "Anonymous Visitor"`, `last_interaction_at`, `conversation_count`, and `message_count`.
>
> Display these as a simple table or list of rows showing:
> - "Anonymous Visitor" label
> - Session date (formatted relative: "Today", "Yesterday", "3 days ago")
> - Number of messages exchanged
>
> This section can be collapsed by default and expanded with a "Show anonymous sessions" toggle.

---

## FIX-D2 — Conversations: Messages Not Displaying + Soul/Memory Display

> **This is a critical fix.** The Conversations page at `/nomii/dashboard/conversations` has a two-panel layout (list on left, detail on right). When you click on a conversation, the right panel should show the message thread — but it currently shows "No messages" or is blank.
>
> **Root cause:** The API endpoint `GET /api/portal/conversations/:id` returns this shape:
> ```json
> {
>   "conversation": { "id": 1, "status": "ended", "created_at": "...", "customer_id": 5, "first_name": "John", "last_name": "Doe", "email": "john@example.com" },
>   "messages": [
>     { "id": 1, "role": "customer", "content": "Hello", "created_at": "..." },
>     { "id": 2, "role": "agent", "content": "Hi there!", "created_at": "..." }
>   ]
> }
> ```
>
> The `messages` array is a **top-level field** in the response, NOT nested inside `conversation`. Make sure the frontend reads `response.data.messages` (or `data.messages`) — NOT `data.conversation.messages`.
>
> **Fix the right panel to:**
> 1. Fetch `GET /api/portal/conversations/:id` when a conversation is clicked
> 2. Read messages from `data.messages` (top-level)
> 3. Render each message as a chat bubble:
>    - `role: "customer"` → left-aligned bubble, light gray background
>    - `role: "agent"` → right-aligned bubble, primary color background with white text
>    - Show timestamp below each bubble (formatted as "Mar 13, 11:02 PM")
> 4. Show the customer name and status at the top of the panel: `data.conversation.first_name` + `data.conversation.last_name`, and status badge (active = green, ended = gray, escalated = red)
> 5. If messages array is empty, show "No messages in this conversation" centered with a chat icon
>
> **Also fix the conversation list (left panel):**
> The list endpoint `GET /api/portal/conversations` returns conversations with `last_message`, `last_message_at`, and `message_count`. Make sure:
> - Each row shows the customer name, a preview of `last_message` (truncated to ~50 chars), and a relative timestamp
> - Conversations with 0 messages should show "No messages yet" as the preview text
> - The currently selected conversation should have a highlighted/active state

---

## FIX-E — Customer Detail: Soul & Memory File Display

> On the Customers page at `/nomii/dashboard/customers`, when you click a customer card to view their detail, the API returns `soul_file` and `memory_file` as JSONB objects.
>
> **API shape for** `GET /api/portal/customers/:id`:
> ```json
> {
>   "customer": {
>     "id": 5,
>     "first_name": "John",
>     "last_name": "Doe",
>     "email": "john@example.com",
>     "soul_file": {
>       "customer_name": "John",
>       "agent_nickname": "Jerry",
>       "personal_profile": {
>         "interests": ["worship music", "Jeremy Riddle"],
>         "preferences": ["short messages"],
>         "personality_traits": ["curious", "warm"],
>         "life_details": ["loves Monday night events"]
>       }
>     },
>     "memory_file": {
>       "conversation_history": [
>         {
>           "session": 1,
>           "date": "2026-03-13",
>           "summary": "John discussed his interest in worship music...",
>           "topics": ["faith", "worship_music"],
>           "message_count": 6
>         }
>       ],
>       "agent_notes": ["John tends to send short messages — keep responses concise"]
>     }
>   }
> }
> ```
>
> **Render two sections in the customer detail view:**
>
> **1. Soul File section** (card with heading "Soul Profile"):
> - Show `agent_nickname` as "Agent Name: Jerry"
> - Show `customer_name` as "Known As: John"
> - Show each `personal_profile` category as a labeled list:
>   - "Interests:" followed by tags/chips for each item
>   - "Preferences:" tags
>   - "Personality:" tags
>   - "Life Details:" tags
> - If soul_file is empty/null or has no personal_profile, show "No soul data yet — the agent is still getting to know this customer."
>
> **2. Memory File section** (card with heading "Conversation Memory"):
> - Show `conversation_history` as a timeline or list:
>   - Each entry: "Session #1 — Mar 13, 2026 (6 messages)" as header
>   - Summary text below
>   - Topics as small tag chips
> - Show `agent_notes` as a separate "Agent Notes" sub-section with bullet points
> - If memory_file is empty/null, show "No memory yet — this customer hasn't had a completed conversation."
>
> These sections should update in real-time when the customer detail is viewed (just refetch on click, no polling needed).

---

## PROMPT 26 — Settings: Chat Bubble Name + Company Description Fix

> Update the Settings page at `/nomii/dashboard/settings` to add a new field and fix an existing one.
>
> **New field: "Chat Bubble Label"**
> Add a text input field in the Settings form labeled "Chat Bubble Label" with placeholder text "e.g. Chat with Steve". This maps to `chat_bubble_name` in the `PUT /api/portal/company` body. The `GET /api/portal/company` response now includes `tenant.chat_bubble_name`.
>
> This controls what text appears on the floating chat button on the customer's website. If left blank, it defaults to "Chat with [Agent Name]".
>
> Place this field right after the "Agent Name" field, since they're related.
>
> **Fix: Company Description not persisting**
> The Company Description textarea on the Settings page should:
> 1. Pre-populate from `tenant.company_description` when the page loads (from `GET /api/portal/company`)
> 2. Send `company_description` in the `PUT /api/portal/company` body when saved
> 3. Verify this is happening — if the field shows empty after saving and refreshing, the value is not being sent in the PUT body
>
> **Also ensure** the onboarding wizard Step 2 (Company Profile) sends `company_description` when it calls `PUT /api/portal/company`. If Step 2 collects a company description field, it MUST include it in the API call body.

---

## PROMPT 27 — Forgot Password Flow

> Add a "Forgot Password?" flow to the login page at `/nomii/login`.
>
> **Login page change:**
> Add a "Forgot your password?" link below the password field on the login form. Clicking it should show a simple form that asks for the user's email address and has a "Send Reset Link" button.
>
> **API endpoints:**
> - `POST /api/onboard/forgot-password` with body `{ email }` — Returns `{ ok: true, message: "..." }` (always succeeds to prevent email enumeration)
> - After submission, show a success message: "If that email is registered, a password reset link has been sent. Check your inbox."
> - Include a "Back to login" link
>
> **Reset Password page:**
> Create a new page at `/nomii/reset-password` that:
> 1. Reads the `token` from the URL query parameter (`?token=abc123`)
> 2. Shows a form with "New Password" and "Confirm Password" fields
> 3. Validates passwords match and are at least 8 characters
> 4. Calls `POST /api/onboard/reset-password` with body `{ token, new_password }`
> 5. On success, shows "Your password has been reset!" with a "Go to Login" button
> 6. On error (expired/invalid token), shows the error message with a "Request a new link" button that navigates back to the forgot password form
>
> **Styling:** Match the existing login page styling — same card layout, Shenmay AI branding, primary color buttons.

---

## PROMPT 28 — Concerns Page: Fix 404 + Conversation Detail

> The Concerns page at `/nomii/dashboard/concerns` lists escalated/flagged conversations. **Clicking on a specific concern currently causes a 404 error.** Fix this.
>
> **Root cause:** There is no separate `/api/portal/concerns/:id` endpoint. A concern IS a conversation — it's just a conversation with `status: 'escalated'`. When a user clicks on a concern row, use the existing `GET /api/portal/conversations/:id` endpoint to load its details and messages.
>
> **Fix:**
> 1. When clicking a concern in the list, fetch `GET /api/portal/conversations/:id` using the concern's `id`
> 2. Display the conversation messages in the same chat-bubble format as the Conversations page (customer messages left, agent messages right)
> 3. Show the flag description at the top of the detail panel (the concern row includes `last_message` which often contains the flag reason)
> 4. Do NOT navigate to a separate `/concerns/:id` URL — either use a side panel (like Conversations) or a modal overlay
> 5. Make sure the back button doesn't break — if you're using client-side routing, ensure the concerns list remains accessible
>
> **Also fix:** After viewing a concern detail, pressing the browser back button should return to the concerns list, NOT redirect to the home page or cause a full page reload.

---

## PROMPT 29 — Dashboard: Fix Button Links + Navigation

> On the Dashboard overview at `/nomii/dashboard`, there are stat cards and action items that should link to their respective detail pages. Fix the following navigation issues:
>
> 1. **"Active Conversations" stat card** — clicking should navigate to `/nomii/dashboard/conversations`
> 2. **"Total Customers" stat card** — clicking should navigate to `/nomii/dashboard/customers`
> 3. **"Open Concerns" stat card** — clicking should navigate to `/nomii/dashboard/concerns`
> 4. **"Complete Setup" banner** (if widget not verified) — clicking should navigate to `/nomii/onboarding`
> 5. **Recent conversations list items** — clicking a conversation row should navigate to `/nomii/dashboard/conversations` with that conversation pre-selected (or use a query param like `?id=123`)
>
> Make all stat cards clickable with a subtle hover effect (slight elevation/shadow change, cursor: pointer). Add a small arrow or "View all →" text that appears on hover.

---

## PROMPT 30 — Auth Security: Protect Dashboard Routes

> **Security fix:** After logging out and pressing the browser back button, the user should NOT be able to see the dashboard. The dashboard pages must be fully protected.
>
> **Requirements:**
> 1. Every dashboard route (`/nomii/dashboard/*`) must check for a valid `nomii_portal_token` in localStorage on mount
> 2. If the token is missing OR expired, immediately redirect to `/nomii/login`
> 3. On logout, clear `nomii_portal_token` from localStorage AND call `window.history.replaceState` to prevent back-button access
> 4. Add a route guard / auth wrapper component that wraps ALL dashboard routes and performs the token check
> 5. The token is a JWT — you can decode it client-side (without verifying the signature) to check the `exp` claim. If `exp < Date.now() / 1000`, treat it as expired.
> 6. When a 401 response comes back from ANY API call, automatically clear the token and redirect to login
>
> **Logout flow should:**
> ```javascript
> localStorage.removeItem('nomii_portal_token');
> window.history.replaceState(null, '', '/nomii/login');
> window.location.href = '/nomii/login';
> ```
>
> This prevents the browser back button from returning to cached dashboard pages after logout.
