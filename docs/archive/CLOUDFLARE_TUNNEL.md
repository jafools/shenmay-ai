> **HISTORICAL — frozen, no longer maintained.** Point-in-time artifact kept for reference only.
> For current state see [`docs/SESSION_NOTES.md`](../SESSION_NOTES.md). Archived 2026-06-18 (audit M3/T15).

---

# Shenmay AI — Cloudflare Tunnel Setup

Expose `api.nomii.pontensolutions.com` → your local backend at `10.0.0.2:3001`, permanently and for free, using Cloudflare Tunnel. No port forwarding, no VPS required.

---

## Overview

You'll add a `cloudflared` container to your existing Docker Compose stack. It creates an outbound-only encrypted tunnel from your VM to Cloudflare's edge — Cloudflare then routes `api.nomii.pontensolutions.com` inward through that tunnel to your Express backend.

```
Lovable / Internet
      │
      ▼
api.nomii.pontensolutions.com  (Cloudflare DNS)
      │
      ▼
Cloudflare Edge (terminates TLS, free)
      │  outbound tunnel (your VM initiated this)
      ▼
cloudflared container (in your Docker network)
      │  internal Docker network
      ▼
shenmay-backend:3001
```

---

## Step 1 — Create the Tunnel in Cloudflare Dashboard

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → select **pontensolutions.com**
2. In the left sidebar: **Zero Trust** → **Networks** → **Tunnels**
3. Click **Create a tunnel** → choose **Cloudflared** → click **Next**
4. Name it: `nomii-ai` → click **Save tunnel**
5. On the next screen, Cloudflare shows you the install command. **Copy only the token** — it's the long string after `--token`. It looks like:
   ```
   eyJhIjoiYWJj...  (very long, ~200 chars)
   ```
   You don't need to run their install commands — you'll use Docker instead.
6. Click **Next** (you'll configure hostnames in Step 3).

---

## Step 2 — Add the Token to Your .env

SSH into your Proxmox VM (`ssh user@10.0.0.2`) and edit the `.env` file in your project directory:

```bash
cd ~/nomii-ai   # or wherever you cloned the project
nano .env
```

Add this line at the bottom (paste your actual token):

```env
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoiYWJj...your_full_token_here
```

Save and exit (`Ctrl+X → Y → Enter`).

---

## Step 3 — Deploy the Updated Docker Compose

Pull the updated `docker-compose.yml` from this repo (or copy it manually — see the file in your workspace). Then bring the stack back up:

```bash
# Pull latest from git (after you push from local)
git pull origin main

# Restart with the new cloudflared service
docker compose up -d

# Confirm all 4 containers are running
docker compose ps
```

You should see: `shenmay-db`, `shenmay-backend`, `shenmay-frontend`, **`shenmay-cloudflared`** — all `Up`.

Check the tunnel is connected:

```bash
docker compose logs cloudflared
```

Look for a line like:
```
INF Connection established connIndex=0 location=ATL
```

That means the tunnel is live.

---

## Step 4 — Configure Public Hostnames in Cloudflare

Back in the Cloudflare dashboard, finish the tunnel setup:

1. **Zero Trust** → **Networks** → **Tunnels** → click `nomii-ai` → **Edit**
2. Click the **Public Hostname** tab → **Add a public hostname**

Add these two hostnames:

### API (required)

| Field | Value |
|-------|-------|
| Subdomain | `api.nomii` |
| Domain | `pontensolutions.com` |
| Type | HTTP |
| URL | `backend:3001` |

### Frontend / Admin UI (optional but handy)

| Field | Value |
|-------|-------|
| Subdomain | `app.nomii` |
| Domain | `pontensolutions.com` |
| Type | HTTP |
| URL | `frontend:80` |

> **Why `backend:3001` and not `localhost:3001`?**
> The `cloudflared` container is on the same Docker network as `backend`. Docker's internal DNS resolves `backend` to the container's IP, so `localhost` would point to the cloudflared container itself.

Click **Save** after each. Cloudflare auto-creates the DNS records in pontensolutions.com.

---

## Step 5 — Test It

From any machine (your laptop, phone, anywhere):

```bash
curl https://api.nomii.pontensolutions.com/api/health
```

Expected response:
```json
{"status":"ok","service":"shenmay-ai","timestamp":"2026-03-10T..."}
```

If you get that, the tunnel is working end-to-end. 🎉

---

## Step 6 — Update the Lovable Widget

Now that you have a permanent public URL, paste this into Lovable (in the component that wraps authenticated pages):

```javascript
// In your authenticated layout component (e.g. src/layouts/AuthLayout.jsx or similar)
// Run this once after confirming a Supabase user session exists

useEffect(() => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || document.getElementById('nomii-widget-script')) return;

  const script = document.createElement('script');
  script.id = 'nomii-widget-script';
  script.src = 'https://api.nomii.pontensolutions.com/embed.js';
  script.setAttribute('data-widget-key', '4e8bb9c05b6ffc22004a4edc65f1e9e43b291014d5803384722e5c7fe001c907');
  script.setAttribute('data-user-email', user.email);
  script.setAttribute('data-user-name', user.user_metadata?.full_name || user.email.split('@')[0]);
  script.setAttribute('data-primary-color', '#4A2C8F');
  script.setAttribute('data-label', 'Chat with Beacon');
  document.body.appendChild(script);

  return () => {
    const existing = document.getElementById('nomii-widget-script');
    if (existing) document.body.removeChild(existing);
  };
}, [user]);
```

Paste into Lovable as a prompt like:

> In the authenticated layout wrapper, after `supabase.auth.getUser()` confirms a session, dynamically inject a `<script>` tag with `src="https://api.nomii.pontensolutions.com/embed.js"`, `data-widget-key="4e8bb9c05b6ffc22004a4edc65f1e9e43b291014d5803384722e5c7fe001c907"`, `data-user-email` from the Supabase user object, `data-user-name` from `user.user_metadata.full_name` (fallback to email prefix), `data-primary-color="#4A2C8F"`, and `data-label="Chat with Beacon"`. Only inject once (check for existing script by id `nomii-widget-script`). Remove on logout cleanup.

---

## Maintenance

```bash
# View tunnel logs
docker compose logs -f cloudflared

# Restart tunnel only
docker compose restart cloudflared

# Check tunnel status in dashboard
# Zero Trust → Networks → Tunnels → nomii-ai → should show "Healthy"
```

The tunnel token is tied to your Cloudflare account. It auto-reconnects on reboot because the `cloudflared` container has `restart: unless-stopped`.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `cloudflared` container exits immediately | Check `docker compose logs cloudflared` — usually a bad token in `.env` |
| `curl` returns connection refused | Wait 30s for tunnel to connect; check logs for `Connection established` |
| `curl` returns 502 Bad Gateway | Backend isn't healthy — run `docker compose ps` and check backend logs |
| Cloudflare shows tunnel as "Inactive" | Container isn't running — `docker compose up -d cloudflared` |
| CORS errors in browser | Backend already uses open CORS (`app.use(cors())`), so this shouldn't happen — check the request URL is exactly `https://api.nomii.pontensolutions.com` |
