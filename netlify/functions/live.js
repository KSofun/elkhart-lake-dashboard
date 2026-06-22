// Live data proxy for the Elkhart Lake dashboard.
// It holds your secret API tokens (set as Netlify environment variables) and
// returns the latest readings to the page, so the tokens never reach the browser.
//
// Add a new sensor later by adding another try/catch block that fetches its API
// and puts the result on the `out` object (e.g. out.buoy = {...}).

exports.handler = async () => {
  const out = { updated: Math.floor(Date.now() / 1000) };

  // ---------- Tempest weather station ----------
  try {
    const token = process.env.TEMPEST_TOKEN;
    const station = process.env.TEMPEST_STATION || "180158";
    const r = await fetch(
      `https://swd.weatherflow.com/swd/rest/observations/station/${station}?token=${token}`
    );
    const j = await r.json();
    const o = j.obs && j.obs[0];
    if (o) {
      const C2F = (c) => (c == null ? null : Math.round((c * 9 / 5 + 32) * 10) / 10);
      const MS2MPH = (m) => (m == null ? null : Math.round(m * 2.2369362921 * 10) / 10);
      const MB2INHG = (p) => (p == null ? null : Math.round(p * 0.0295299830714 * 100) / 100);
      out.weather = {
        epoch: o.timestamp,
        airTemp: C2F(o.air_temperature),
        feels: C2F(o.feels_like),
        humidity: o.relative_humidity,
        wind: MS2MPH(o.wind_avg),
        gust: MS2MPH(o.wind_gust),
        uv: o.uv == null ? null : Math.round(o.uv * 10) / 10,
        pressure: MB2INHG(o.sea_level_pressure != null ? o.sea_level_pressure : o.station_pressure),
      };
    }
  } catch (e) {
    out.weatherError = String(e);
  }

  // ---------- Manhole Metrics water level ----------
  try {
    const key = process.env.MANHOLE_KEY;
    const device = process.env.MANHOLE_DEVICE || "926";
    const since = Math.floor(Date.now() / 1000) - 3 * 86400; // last 3 days
    const r = await fetch(
      `https://client-device-service.manhole-metrics.com/client_device?device_id=${device}&starting_unix_timestamp=${since}&filter_water_level=true`,
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
