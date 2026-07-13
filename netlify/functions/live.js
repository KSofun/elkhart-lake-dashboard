// Live data proxy for the Elkhart Lake dashboard.
// It holds your secret API tokens (set as Netlify environment variables) and
// returns the latest readings to the page, so the tokens never reach the browser.
//
// Add a new sensor later by adding another try/catch block that fetches its API
// and puts the result on the `out` object (e.g. out.buoy = {...}).

exports.handler = async () => {
  const out = { updated: Math.floor(Date.now() / 1000) };

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
    if (email && password) {
      const authRes = await fetch("https://algae-auth.herokuapp.com/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "mutation authUser($email:String!,$password:String!){authUser(email:$email,password:$password){authToken}}",
          variables: { email, password },
        }),
      });
      const aj = await authRes.json();
      const token = aj && aj.data && aj.data.authUser && aj.data.authUser.authToken;
      if (!token) {
        out.buoyDebug = { step: "login", httpStatus: authRes.status, errors: (aj && aj.errors) || "no token in response" };
      } else {
        const sumRes = await fetch("https://algae-device.herokuapp.com/slotSummaries", {
          headers: { Authorization: "Bearer " + token },
        });
        const arr = await sumRes.json();
        // Pick the Elkhart Lake buoy: AQUA_SLOT override, else nearest to Elkhart coords.
        const ELK_LAT = 43.82, ELK_LON = -88.03, target = process.env.AQUA_SLOT;
        let pick = null, best = Infinity;
        (Array.isArray(arr) ? arr : []).forEach((t) => {
          if (target && t._id === target) { pick = t; best = -1; return; }
          if (best === -1) return;
          const dLat = (t.gpsLat || 0) - ELK_LAT, dLon = (t.gpsLong || 0) - ELK_LON;
          const d = dLat * dLat + dLon * dLon;
          if (d < best) { best = d; pick = t; }
        });
        if (pick) {
          const C2F = (c) => (c == null ? null : Math.round((c * 9 / 5 + 32) * 10) / 10);
          const n2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
          const sv = {};
          (pick.values || []).forEach((x) => { sv[x.name] = x.value; });
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
          const seen = {}, good = {};
          try {
            const now = Date.now();
            const histRes = await fetch(`https://algae-device.herokuapp.com/devices/${pick._id}/history/v2`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
              body: JSON.stringify({
                startDate: new Date(now - 4 * 86400 * 1000).toISOString(),
                endDate: new Date(now).toISOString(),
              }),
            });
            const hist = await histRes.json();
            (Array.isArray(hist) ? hist : []).forEach((r) => {
              const t = Date.parse(r.handshakeTime) || 0, x = r.val;
              seen[r.name] = 1;
              const f = OK[r.name];
              if (x != null && (!f || f(x)) && (!good[r.name] || t > good[r.name].t)) good[r.name] = { v: x, t };
            });
          } catch (e) { out.buoyHistError = String(e); }
          const g = (n) => (good[n] ? good[n].v : null);
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
          out.buoyChannels = Object.keys(seen); // temp: confirms the solar-light channel name
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
