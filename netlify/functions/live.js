// Live data proxy for the Elkhart Lake dashboard.
// It holds your secret API tokens (set as Netlify environment variables) and
// returns the latest readings to the page, so the tokens never reach the browser.
//
// Add a new sensor later by adding another try/catch block that fetches its API
// and puts the result on the `out` object (e.g. out.buoy = {...}).

// The Aqua API is rate-sensitive: it starts returning empty history if we hit it too often.
// Netlify reuses warm containers, so cache the auth token and the buoy result at module scope
// instead of re-authenticating and re-pulling history on every single request.
let CACHE = { token: null, tokenAt: 0, buoy: null, buoyStats: null, buoyAt: 0, dbg: null, lastGood: {} };
const LASTGOOD_TTL = 12 * 60 * 60 * 1000; // remember a channel's last real reading for 12h
const TOKEN_TTL = 40 * 60 * 1000; // reuse the auth token for 40 min
// The buoy's summary packet flips between real optical values and zeros. Poll it often enough to
// catch the good packets (each real reading is remembered by CACHE.lastGood below).
const BUOY_TTL = 60 * 1000;

exports.handler = async (event) => {
  const out = { updated: Math.floor(Date.now() / 1000) };
  // ?fresh=1 bypasses the buoy cache (for debugging the vendor API)
  const FRESH = !!(event && event.queryStringParameters && event.queryStringParameters.fresh);

  // ---------- Tempest weather station ----------
  // Use the DEVICE observations endpoint (real-time). The station-level endpoint
  // can freeze on a stale reading even while the device keeps reporting.
  try {
    const token = process.env.TEMPEST_TOKEN;
    const device = process.env.TEMPEST_DEVICE || "425196";
    const r = await fetch(
      `https://swd.weatherflow.com/swd/rest/observations?device_id=${device}&token=${token}`
    );
    const j = await r.json();
    const o = j.obs && j.obs[0]; // obs_st array: [epoch, lull, windAvg, gust, dir, sampInt, stnPressMB, airC, RH, lux, uv, solar, rain, ...]
    if (o) {
      const C2F = (c) => (c == null ? null : Math.round((c * 9 / 5 + 32) * 10) / 10);
      const MS2MPH = (m) => (m == null ? null : Math.round(m * 2.2369362921 * 10) / 10);
      const MB2INHG = (p) => (p == null ? null : Math.round(p * 0.0295299830714 * 100) / 100);
      const sum = j.summary || {};
      out.weather = {
        epoch: o[0],
        airTemp: C2F(o[7]),
        feels: C2F(sum.feels_like != null ? sum.feels_like : o[7]),
        humidity: o[8],
        wind: MS2MPH(o[2]),
        gust: MS2MPH(o[3]),
        uv: o[10] == null ? null : Math.round(o[10] * 10) / 10,
        pressure: MB2INHG(o[6]),
        rainIn: (() => {
          const mm = sum.precip_accum_local_day != null ? sum.precip_accum_local_day
            : (o[18] != null ? o[18] : (o[12] != null ? o[12] : null));
          return mm == null ? null : Math.round(mm * 0.0393700787 * 100) / 100;
        })(),
      };
    } else {
      // non-sensitive breadcrumb so we can tell "offline" from "bad token"
      out.weatherDebug = { httpStatus: r.status, message: (j.status && j.status.status_message) || "no obs returned" };
    }
  } catch (e) {
    out.weatherError = String(e);
  }

  // ---------- AquaSens dock water-temperature sensor (public, no key) ----------
  try {
    const sensor = process.env.AQUASENS_SENSOR || "B4:3A:45:8A:45:C8";
    const r = await fetch(
      `https://mgadwaxamcxuxappbyfr.supabase.co/functions/v1/latest-reading?sensor_id=${encodeURIComponent(sensor)}`
    );
    if (r.ok) {
      const j = await r.json();
      if (j && j.temperature != null) {
        out.waterTemp = {
          tempF: Math.round(j.temperature * 10) / 10,
          epoch: j.timestamp ? Math.floor(new Date(j.timestamp).getTime() / 1000) : out.updated,
        };
      } else {
        out.waterTempDebug = { httpStatus: r.status, message: "no temperature in response" };
      }
    } else {
      out.waterTempDebug = { httpStatus: r.status, message: "non-200 from sensor API" };
    }
  } catch (e) {
    out.waterTempError = String(e);
  }

  // ---------- Aqua Real Time water-quality buoy ----------
  // Flow: POST email+password to the GraphQL auth endpoint to get a token,
  // then GET /slotSummaries (latest reading per tracker) with that token.
  // Credentials live ONLY in Netlify env vars (AQUA_EMAIL, AQUA_PASSWORD).
  // This first pass returns the raw summary shape as buoyDebug so we can map fields.
  try {
    const email = process.env.AQUA_EMAIL, password = process.env.AQUA_PASSWORD;
    const nowMs = Date.now();
    if (email && password && !FRESH && CACHE.buoy && nowMs - CACHE.buoyAt < BUOY_TTL) {
      // still fresh from a recent invocation - don't touch their API at all
      out.buoy = CACHE.buoy;
      out.buoyStats = CACHE.buoyStats || {};
      out.buoyCached = true;
      if (CACHE.dbg) out.buoyHistDebug = CACHE.dbg;
    } else if (email && password) {
      let token = CACHE.token && nowMs - CACHE.tokenAt < TOKEN_TTL ? CACHE.token : null;
      let authStatus = null;
      if (!token) {
        const authRes = await fetch("https://algae-auth.herokuapp.com/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "mutation authUser($email:String!,$password:String!){authUser(email:$email,password:$password){authToken}}",
            variables: { email, password },
          }),
        });
        authStatus = authRes.status;
        const aj = await authRes.json();
        token = (aj && aj.data && aj.data.authUser && aj.data.authUser.authToken) || null;
        if (token) { CACHE.token = token; CACHE.tokenAt = nowMs; }
      }
      if (!token) {
        out.buoyDebug = { step: "login", httpStatus: authStatus, errors: "no token in response" };
      } else {
        const sumRes = await fetch("https://algae-device.herokuapp.com/slotSummaries", {
          headers: { Authorization: "Bearer " + token },
        });
        const arr = await sumRes.json();
        // The vendor docs say the SlotId for /history/v2 comes from GET /slots (NOT from
        // slotSummaries). Pull it, so we can try the correct id.
        let slots = null;
        try {
          const slotRes = await fetch("https://algae-device.herokuapp.com/slots", {
            headers: { Authorization: "Bearer " + token },
          });
          const sj = await slotRes.json();
          slots = Array.isArray(sj) ? sj : (sj && Array.isArray(sj.slots) ? sj.slots : null);
          out.buoySlotsDebug = {
            status: slotRes.status,
            count: slots ? slots.length : null,
            sample: slots ? slots.slice(0, 3).map((s) => ({ _id: s._id, id: s.id, slotId: s.slotId, name: s.name, keys: Object.keys(s).slice(0, 16) })) : (sj && typeof sj === "object" ? Object.keys(sj).slice(0, 10) : null),
          };
        } catch (e) { out.buoySlotsError = String(e); }
        // Route to the ELKHART buoy only. The account also carries an unrelated buoy in Canada,
        // so pin ours by serial number (AQUA_BUOY, default B404-321). Fall back to an explicit
        // slot id, then to nearest-to-Elkhart, so this can never silently pick the wrong one.
        const list = Array.isArray(arr) ? arr : [];
        const WANT = (process.env.AQUA_BUOY || "B404-321").trim().toLowerCase();
        const ELK_LAT = 43.82, ELK_LON = -88.03, target = process.env.AQUA_SLOT;
        let pick = list.find((t) => target && t._id === target) || null;
        if (!pick) pick = list.find((t) => (t.name || "").trim().toLowerCase() === WANT) || null;
        if (!pick) pick = list.find((t) => (t.name || "").toLowerCase().includes(WANT)) || null;
        if (!pick) {
          let best = Infinity;
          list.forEach((t) => {
            const dLat = (t.gpsLat || 0) - ELK_LAT, dLon = (t.gpsLong || 0) - ELK_LON;
            const d = dLat * dLat + dLon * dLon;
            if (d < best) { best = d; pick = t; }
          });
        }
        if (pick) {
          const C2F = (c) => (c == null ? null : Math.round((c * 9 / 5 + 32) * 10) / 10);
          const n2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
          const sv = {};
          (pick.values || []).forEach((x) => { sv[x.name] = x.value; });
          if (FRESH) { out.buoyRawSummary = sv; out.buoyLastGood = CACHE.lastGood; }
          // The raw feed has spikes (0s and wild highs) - the vendor portal has a
          // "spike removal" toggle for exactly this. Accept only readings inside a sane
          // range per channel, then take the most recent good one.
          const LIGHTS = ["light", "solar", "solarLight", "par", "solarRadiation"];
          const OK = {
            waterTemp: (x) => x > -5 && x < 45 && x !== 0,
            airTemp: (x) => x > -50 && x < 60 && x !== 0,
            turbidity: (x) => x > 0 && x < 500,
            chlorA: (x) => x > 0 && x < 5000,
            phycocyanin: (x) => x > 0 && x < 5000,
          };
          LIGHTS.forEach((n) => { OK[n] = (x) => x >= 0 && x < 10000; });
          const seen = {}, good = {}, series = {};
          let histInfo = null;
          // Their history endpoint sometimes answers 200 with an empty array. Retry with
          // progressively shorter windows before giving up.
          // Their docs' examples use whole-hour timestamps ("2024-11-05T07:00:00.000Z"), so try
          // that shape as well as a plain ISO now-stamp.
          const iso = (ms, roundHour) => {
            const d = new Date(ms);
            if (roundHour) d.setUTCMinutes(0, 0, 0);
            return d.toISOString();
          };
          const pullHist = async (id, days, roundHour) => {
            const now = Date.now();
            const r = await fetch(`https://algae-device.herokuapp.com/devices/${id}/history/v2`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
              body: JSON.stringify({
                startDate: iso(now - days * 86400 * 1000, roundHour),
                endDate: iso(now, roundHour),
              }),
            });
            let j = null;
            try { j = await r.json(); } catch (e2) { return { status: r.status, arr: null, id, days }; }
            return { status: r.status, arr: Array.isArray(j) ? j : null, id, days, roundHour, keys: !Array.isArray(j) && j && typeof j === "object" ? Object.keys(j).slice(0, 8) : undefined };
          };
          // We don't know which id /history/v2 wants, so harvest EVERY Mongo-style id from the
          // slot + summary objects and try each one. Whichever returns rows is the right id.
          const nm = (pick.name || "").trim();
          let slotMatch = null;
          if (Array.isArray(slots)) {
            slotMatch = slots.find((s) => ((s.name || "").trim() === nm)) || slots.find((s) => s._id === pick._id) || null;
          }
          if (FRESH && slotMatch) out.buoySlotFull = slotMatch;
          // /devices/{id}/history/v2 wants the DEVICE id, which lives in moments[].device_id -
          // NOT the slot _id. Try the device id first, then fall back to the slot id.
          const ids = [];
          const isId = (v) => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);
          const addId = (v) => { if (isId(v) && !ids.includes(v)) ids.push(v); };
          const moments = (slotMatch && Array.isArray(slotMatch.moments) ? slotMatch.moments : [])
            .concat(pick && Array.isArray(pick.moments) ? pick.moments : []);
          moments.forEach((m) => addId(m && m.device_id));
          if (slotMatch) addId(slotMatch._id);
          addId(pick._id);
          try {
            let hist = null;
            const tried = [];
            outer: for (const id of ids) {
              for (const rh of [false, true]) {
                const res = await pullHist(id, 2, rh);
                tried.push({ id, roundHour: rh, status: res.status, len: res.arr ? res.arr.length : null });
                if (res.arr && res.arr.length) { hist = res.arr; break outer; }
              }
            }
            // DIAGNOSTIC: does history work for the OTHER buoy on this account? If it returns rows
            // there but not here, the difference is the per-device timeSeriesEnabled/subscription.
            if (FRESH && Array.isArray(slots)) {
              out.buoyHistProbe = [];
              for (const s of slots) {
                const p = await pullHist(s._id, 2, false);
                out.buoyHistProbe.push({
                  name: (s.name || "").trim(),
                  timeSeriesEnabled: s.timeSeriesEnabled,
                  subscription: s.subscription_name,
                  configured: s.configured,
                  histStatus: p.status,
                  histRows: p.arr ? p.arr.length : null,
                });
              }
            }
            // last resort: the pre-v2 endpoint, in case /v2 is not what this account uses
            if (!hist && ids.length) {
              try {
                const now2 = Date.now();
                const r2 = await fetch(`https://algae-device.herokuapp.com/devices/${ids[0]}/history`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
                  body: JSON.stringify({ startDate: new Date(now2 - 2 * 86400 * 1000).toISOString(), endDate: new Date(now2).toISOString() }),
                });
                const j2 = await r2.json();
                tried.push({ id: ids[0], endpoint: "history (no v2)", status: r2.status, len: Array.isArray(j2) ? j2.length : null });
                if (Array.isArray(j2) && j2.length) hist = j2;
              } catch (e3) { tried.push({ endpoint: "history (no v2)", error: String(e3) }); }
            }
            histInfo = { tried, matchedSlot: !!slotMatch };
            (hist || []).forEach((r) => {
              const t = Date.parse(r.handshakeTime) || 0, x = r.val;
              seen[r.name] = 1;
              const f = OK[r.name];
              if (x != null && (!f || f(x))) {
                (series[r.name] = series[r.name] || []).push({ v: x, t });
                if (!good[r.name] || t > good[r.name].t) good[r.name] = { v: x, t };
              }
            });
          } catch (e) { out.buoyHistError = String(e); }
          // If history came back empty, don't blank the tiles: fall back to the single latest
          // packet from slotSummaries, run through the same sanity filter.
          if (!Object.keys(seen).length) out.buoyHistDebug = histInfo || "no response";
          // Value priority: (1) newest good reading from history, (2) the latest slotSummaries
          // packet if it passes the sanity filter, (3) the last real reading we saw within 12h.
          // The buoy's summary packet flips intermittently between real values and zeros, so
          // without (3) a tile would vanish every time a zero packet lands.
          CACHE.lastGood = CACHE.lastGood || {};
          const g = (n) => {
            if (good[n]) { CACHE.lastGood[n] = { v: good[n].v, t: nowMs }; return good[n].v; }
            const x = sv[n], f = OK[n];
            if (x != null && (!f || f(x))) { CACHE.lastGood[n] = { v: x, t: nowMs }; return x; }
            const lg = CACHE.lastGood[n];
            return lg && nowMs - lg.t < LASTGOOD_TTL ? lg.v : null;
          };
          const gt = (n) => (good[n] ? Math.floor(good[n].t / 1000) : null);
          const lightKey = LIGHTS.find((n) => seen[n]);
          out.buoy = {
            epoch: gt("waterTemp") || pick.device_last_publish || sv.utcTime || out.updated,
            name: (pick.name || "").trim(),
            waterTempF: C2F(g("waterTemp")),
            airTempF: C2F(g("airTemp")),
            turbidity: n2(g("turbidity")),
            chlorA: n2(g("chlorA")),
            phycocyanin: n2(g("phycocyanin")),
            light: lightKey ? n2(g(lightKey)) : null,
          };

          // Where does "now" sit within this buoy's own recent readings? (USGS WaterWatch pattern:
          // report position vs. the site's own history rather than invent absolute good/bad bands,
          // which is not defensible for relative fluorescence units.)
          const statsFor = (n, conv) => {
            const raw = series[n] || [];
            if (raw.length < 4) return null;
            const c = conv || ((x) => x);
            const vals = raw.map((o) => c(o.v)).sort((a, b) => a - b);
            const q = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round((vals.length - 1) * p)))];
            const cur = good[n] ? c(good[n].v) : null;
            const below = cur == null ? null : vals.filter((v) => v < cur).length;
            const cutoff = Date.now() - 24 * 3600 * 1000;
            const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
            const r24 = avg(raw.filter((o) => o.t > cutoff).map((o) => c(o.v)));
            const rPrev = avg(raw.filter((o) => o.t <= cutoff).map((o) => c(o.v)));
            let trend = "steady";
            if (r24 != null && rPrev != null && Math.abs(rPrev) > 1e-9) {
              const d = (r24 - rPrev) / Math.abs(rPrev);
              if (d > 0.15) trend = "rising";
              else if (d < -0.15) trend = "falling";
            }
            return {
              n: vals.length,
              min: Math.round(q(0.05) * 100) / 100,
              med: Math.round(q(0.5) * 100) / 100,
              max: Math.round(q(0.95) * 100) / 100,
              pct: below == null ? null : Math.round((below / vals.length) * 100),
              trend,
            };
          };
          const C2Fv = (c) => (c * 9) / 5 + 32;
          out.buoyStats = {};
          [["waterTemp", C2Fv], ["turbidity", null], ["chlorA", null], ["phycocyanin", null]].forEach(([n, cv]) => {
            const s = statsFor(n, cv);
            if (s) out.buoyStats[n] = s;
          });
          out.buoyChannels = Object.keys(seen);
          // Cache so subsequent invocations reuse this instead of hammering their API.
          CACHE.buoy = out.buoy;
          CACHE.buoyStats = out.buoyStats;
          CACHE.buoyAt = nowMs;
          CACHE.dbg = out.buoyHistDebug || null;
        } else {
          out.buoyDebug = { step: "select", message: "no tracker matched", count: Array.isArray(arr) ? arr.length : 0 };
        }
      }
    } else {
      out.buoyDebug = { step: "config", message: "AQUA_EMAIL / AQUA_PASSWORD not set in Netlify env" };
    }
  } catch (e) {
    out.buoyError = String(e);
  }

  // ---------- Manhole Metrics water level ----------
  try {
    const key = process.env.MANHOLE_KEY;
    const device = process.env.MANHOLE_DEVICE || "926";
    const since = Math.floor(Date.now() / 1000) - 3 * 86400; // last 3 days
    const r = await fetch(
      `https://client-device.manhole-metrics.com/client_device?device_id=${device}&starting_unix_timestamp=${since}&filter_water_level=true`,
      { headers: { api_key: key } }
    );
    const j = await r.json();
    const ms = j.water_level_measurements || [];
    // most recent measurement (robust to array order)
    const last = ms.reduce(
      (a, b) => (!a || b.measurement_unix_timestamp > a.measurement_unix_timestamp ? b : a),
      null
    );
    if (last) {
      out.level = {
        epoch: last.measurement_unix_timestamp,
        level: Math.round((last.water_level_mm / 25.4) * 10) / 10, // mm -> inches
      };
    } else if (j.last_water_level != null) {
      out.level = { epoch: out.updated, level: Math.round((j.last_water_level / 25.4) * 10) / 10 };
    }
  } catch (e) {
    out.levelError = String(e);
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      // cache for 60s so many visitors share one fetch and we stay within API rate limits
      "Cache-Control": "public, max-age=60",
    },
    body: JSON.stringify(out),
  };
};
