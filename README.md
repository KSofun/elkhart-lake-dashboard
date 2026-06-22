# Elkhart Lake — Live Dashboard (GitHub + Netlify)

This folder is your whole website. It has 3 things:

- `index.html` — the dashboard (all charts, photos, and data are inside this one file).
- `netlify.toml` — a tiny settings file that tells Netlify what to do.
- `netlify/functions/live.js` — a small program that fetches the LIVE sensor data using your secret tokens, so the tokens stay private.

Follow the steps below in order. It takes about 15 minutes. You only have to do the full setup once. After that, updating is two clicks.

---

## IMPORTANT about your tokens (read this once)

Your Tempest token and your Manhole Metrics key are SECRETS. They are NOT in any of these files.
You will paste them into Netlify's "Environment variables" screen (Step 3). Never put them in a file you upload to GitHub.

You need these two values handy:
- Tempest token (the one named "Elkhart Lake")
- Manhole Metrics API key

---

## Step 1 — Put these files on GitHub

1. Go to **github.com** and sign in (your account is **KSofun**).
2. Top-right, click the **`+`** then **"New repository"**.
3. Repository name: type **`elkhart-lake-dashboard`**. Leave it **Public**. Click **"Create repository"**.
4. On the next page, click the blue link **"uploading an existing file"**.
5. Open this `elkhart-live` folder on your computer. Select **index.html**, **netlify.toml**, AND the **netlify** folder, and **drag all of them** into the upload box on GitHub. (Dragging the `netlify` folder keeps the `functions/live.js` file inside it — that's required.)
6. Scroll down, click **"Commit changes"**.

You now have your code on GitHub.

## Step 2 — Connect Netlify to GitHub

1. Go to **app.netlify.com** and sign in.
2. Click **"Add new site"** → **"Import an existing project"**.
3. Click **"Deploy with GitHub"** (approve/authorize if it asks).
4. Choose the **elkhart-lake-dashboard** repository you just made.
5. Leave all the build settings as they are (Netlify reads `netlify.toml` automatically). Click **"Deploy site"**.

Wait about a minute. Netlify gives you a web address like `https://something-random-12345.netlify.app`.

## Step 3 — Add your secret tokens

1. In your new Netlify site, click **"Site configuration"** (left menu) → **"Environment variables"**.
2. Click **"Add a variable"** → **"Add a single variable"** and add these two (Key on the left, your secret value on the right):
   - Key: **`TEMPEST_TOKEN`**  Value: *your Tempest token*
   - Key: **`MANHOLE_KEY`**  Value: *your Manhole Metrics API key*
3. (Optional, only if your IDs ever change — they are already built in as defaults: `TEMPEST_STATION` = 180158, `MANHOLE_DEVICE` = 926.)
4. Go to the **"Deploys"** tab → **"Trigger deploy"** → **"Deploy site"**. This restarts it with the tokens loaded.

## Step 4 — Check that it's live

1. Open your site address. Click the **Weather Station** and **Water Level Monitor** tabs. The reading strip at the top should say **"Live now"** with current numbers.
2. To double-check the data feed directly, visit this address (replace the first part with your real site name):
   `https://YOUR-SITE-NAME.netlify.app/.netlify/functions/live`
   You should see a small block of JSON with `weather` and `level` in it. If you see `weatherError` or `levelError`, the token for that one is missing or wrong — fix it in Step 3.

That's it. Your dashboard is publicly live and refreshing itself every couple of minutes. 🎉

---

## Updating it later (two clicks)

When I send you a new `index.html` from Cowork:
1. In your GitHub repo, click **index.html** → the **pencil (Edit)** icon → delete all, paste the new file… OR simpler: on the repo's main page click **"Add file" → "Upload files"**, drag the new `index.html` in, and **"Commit changes"** (it replaces the old one).
2. Netlify sees the change and redeploys automatically in about a minute.

## Adding a new sensor later (buoy, water temperature, etc.)

You won't have to rebuild from scratch. The function is built to grow:
1. In `netlify/functions/live.js`, copy one of the existing `try { ... } catch` blocks, point it at the new sensor's API, and put the result on the `out` object (for example `out.buoy = {...}`).
2. Add that sensor's token as a new Netlify environment variable.
3. I'll update `index.html` to display the new live values.

## Notes

- **Cost:** Netlify's free plan covers this. If traffic ever gets heavy, the Pro plan is about $19/month, or we host the photos separately to shrink the page.
- **Custom domain (optional):** Netlify → **Domain settings** → **"Add a domain"**, then follow its instructions.
- **The page still works without the function** (it shows the last saved snapshot), so it never looks broken.
