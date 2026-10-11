# Databricks notebook source
# MAGIC %md
# MAGIC # Echo: Florida hot-car risk forecast
# MAGIC
# MAGIC A child left in a parked car can die from heatstroke on a day that feels merely warm. This notebook
# MAGIC turns live Florida weather into the number a parent needs: **how many minutes a parked car takes to
# MAGIC reach 104°F**, the same danger line Echo's box uses, for every hour of the next day in six cities.
# MAGIC
# MAGIC 1. **Weather in:** the Google Maps Platform Weather API gives the last 24 hours (`history/hours:lookup`)
# MAGIC    and the next 24 hours (`forecast/hours:lookup`) of hourly weather per city.
# MAGIC 2. **Cabin heating:** each daytime hour's outdoor temperature runs through a published parked-car
# MAGIC    heating curve (below), giving minutes to 104°F and a risk level.
# MAGIC 3. **Out:** observed hours are merged into a Delta table that grows with every run (Google keeps only
# MAGIC    24 h of history); the risk forecast overwrites its own table each run; the worst forecast hour in
# MAGIC    Florida is written as `insights.json` for the app's Heat insights screen.
# MAGIC
# MAGIC **The cabin curve.** Jan Null's (San Jose State) table from McLaren, Null & Quinn, *Pediatrics* 2005;116:e109:
# MAGIC a dark sedan in full sun on 16 clear days (72–96°F outside) rose about 19°F in 10 minutes, 29°F in 20,
# MAGIC 34°F in 30, and 43°F in 60, whatever the outside temperature. It assumes full sun, so cloudy hours read
# MAGIC more dangerous than they are, which is the safe direction. Night hours get no sun-driven rise and no estimate.
# MAGIC
# MAGIC **Insights only.** Nothing here feeds the box's alert levels, `minsToDanger`, the backup ladder, or calls.
# MAGIC The box's own sensor decides every alert. This forecast shows why there is no safe waiting time.
# MAGIC
# MAGIC **One-time setup**
# MAGIC 1. In the Google Cloud project, enable **Weather API** and create an API key restricted to the Weather API.
# MAGIC 2. Store the key in a Databricks secret scope, never in this notebook or in git:
# MAGIC    `databricks secrets create-scope echo` then `databricks secrets put-secret echo google_weather_api_key`.
# MAGIC 3. Set the widgets below, Run all once, then **Schedule** the notebook hourly.
# MAGIC 4. Copy the printed `insights.json` into the repo's `app/assets/insights.json` (the app never calls Databricks).
# MAGIC
# MAGIC Cost: two requests per city per run (six cities hourly is about 8,600 requests a month). Check the
# MAGIC Weather API pricing page against your free monthly allowance before adding cities or running more often.

# COMMAND ----------

# Plain functions: standard library only, so they can be sanity-checked outside
# Databricks with a saved API response.
import json
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HISTORY_URL = "https://weather.googleapis.com/v1/history/hours:lookup"
FORECAST_URL = "https://weather.googleapis.com/v1/forecast/hours:lookup"
HOURS = 24  # The history endpoint's maximum lookback; the forecast looks as far ahead.
REQUEST_TIMEOUT_S = 20

# Danger temperature, the same value the box uses (docs/firmware.md "Minutes to danger").
DANGER_TEMP_F = 104.0

# Minutes parked -> °F above the outside temperature (Jan Null, SJSU; McLaren, Null & Quinn 2005).
CABIN_RISE_F = [(0, 0.0), (10, 19.0), (20, 29.0), (30, 34.0), (40, 38.0), (50, 41.0), (60, 43.0)]

# Risk by minutes until a parked car reaches DANGER_TEMP_F, checked in order.
RISK_LEVELS = [(10, "EXTREME"), (20, "HIGH"), (60, "ELEVATED")]

# Spread across the state; add a row here to track another place.
FLORIDA_CITIES = [
    ("Miami", 25.7617, -80.1918),
    ("Orlando", 28.5384, -81.3789),
    ("Tampa", 27.9506, -82.4572),
    ("Jacksonville", 30.3322, -81.6557),
    ("Tallahassee", 30.4383, -84.2807),
    ("Fort Myers", 26.6406, -81.8723),
]


def _parse_utc(text):
    """Parses the API's RFC 3339 times, e.g. 2025-02-12T22:00:00Z, to aware UTC."""
    text = text.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    # Python before 3.11 wants exactly 3 or 6 fractional digits; the API can send 9.
    if "." in text:
        head, rest = text.split(".", 1)
        digits = rest[:len(rest) - len(rest.lstrip("0123456789"))]
        text = head + "." + digits[:6].ljust(6, "0") + rest[len(digits):]
    return datetime.fromisoformat(text).astimezone(timezone.utc)


def _degrees_f(temp):
    """Returns a {degrees, unit} temperature in °F, or None if it is missing."""
    if not temp or temp.get("degrees") is None:
        return None
    degrees = float(temp["degrees"])
    if temp.get("unit") == "CELSIUS":
        degrees = degrees * 9.0 / 5.0 + 32.0
    return round(degrees, 1)


def hour_row(city, lat, lng, hour, fetched_at):
    """Flattens one `historyHours[]` or `forecastHours[]` record into a table row."""
    local = hour.get("displayDateTime") or {}
    condition = hour.get("weatherCondition") or {}
    return {
        "city": city,
        "latitude": lat,
        "longitude": lng,
        "hour_start_utc": _parse_utc(hour["interval"]["startTime"]),
        "local_date": "%04d-%02d-%02d" % (local["year"], local["month"], local["day"]) if local else None,
        "local_hour": local.get("hours"),
        "is_daytime": hour.get("isDaytime"),
        "condition": (condition.get("description") or {}).get("text"),
        "temp_f": _degrees_f(hour.get("temperature")),
        "feels_like_f": _degrees_f(hour.get("feelsLikeTemperature")),
        "heat_index_f": _degrees_f(hour.get("heatIndex")),
        "relative_humidity": hour.get("relativeHumidity"),
        "uv_index": hour.get("uvIndex"),
        "cloud_cover": hour.get("cloudCover"),
        "fetched_at_utc": fetched_at,
    }


def fetch_hours(api_key, url, list_key, lat, lng):
    """Returns the hourly records (`historyHours` or `forecastHours`) for 24 hours at one point.

    The key goes in a header, not the URL, so it never shows up in error messages.
    """
    hours, page_token = [], None
    while True:
        params = {
            "location.latitude": lat,
            "location.longitude": lng,
            "hours": HOURS,
            "pageSize": HOURS,
            "unitsSystem": "IMPERIAL",
        }
        if page_token:
            params["pageToken"] = page_token
        req = urllib.request.Request(url + "?" + urllib.parse.urlencode(params),
                                     headers={"X-Goog-Api-Key": api_key})
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
            body = json.load(resp)
        hours.extend(body.get(list_key, []))
        page_token = body.get("nextPageToken")
        if not page_token:
            return hours


def cabin_rise_f(minutes):
    """°F a parked car in full sun climbs above outside after `minutes` (0-60), interpolated."""
    for (m0, r0), (m1, r1) in zip(CABIN_RISE_F, CABIN_RISE_F[1:]):
        if minutes <= m1:
            return r0 + (r1 - r0) * (max(minutes, m0) - m0) / (m1 - m0)
    return CABIN_RISE_F[-1][1]


def minutes_to_danger(outside_f):
    """Minutes until a parked car reaches DANGER_TEMP_F, or None if not within the curve's hour."""
    need = DANGER_TEMP_F - outside_f
    if need <= 0:
        return 0.0
    for (m0, r0), (m1, r1) in zip(CABIN_RISE_F, CABIN_RISE_F[1:]):
        if need <= r1:
            return m0 + (m1 - m0) * (need - r0) / (r1 - r0)
    return None


def risk_level(minutes):
    if minutes is None:
        return "WATCH"
    for limit, name in RISK_LEVELS:
        if minutes <= limit:
            return name
    return "WATCH"


def add_risk(row):
    """Adds cabin estimates and risk to an hourly row. Night hours get no sun-driven estimate.

    A missing `is_daytime` counts as daytime, so a gap in the data never hides a risk.
    """
    out = dict(row)
    sunny = row.get("is_daytime") is not False and row.get("temp_f") is not None
    for m in (10, 30, 60):
        out["cabin_%d_min_f" % m] = round(row["temp_f"] + cabin_rise_f(m), 1) if sunny else None
    minutes = minutes_to_danger(row["temp_f"]) if sunny else None
    out["minutes_to_danger"] = None if minutes is None else round(minutes, 1)
    out["risk"] = risk_level(minutes) if sunny else "NIGHT"
    return out


def time_of_day_word(hour):
    if 5 <= hour < 12:
        return "morning"
    if 12 <= hour < 17:
        return "afternoon"
    if 17 <= hour < 21:
        return "evening"
    return "night"


def forecast_insights(risk_rows, generated_at):
    """Builds the app's insights.json from the worst forecast hour (fewest minutes to danger).

    Same shape as notebooks/heat_test.py's export, with `source` "databricks forecast" and a
    `place`. `real` is False: this is a forecast, not a real heat test.
    """
    scored = [r for r in risk_rows if r["minutes_to_danger"] is not None and r.get("local_hour") is not None]
    if not scored:
        raise ValueError("no daytime forecast hour reaches danger within an hour, nothing to export")
    worst = min(scored, key=lambda r: (r["minutes_to_danger"], -r["temp_f"], r["hour_start_utc"]))
    outside = worst["temp_f"]
    minutes = minutes_to_danger(outside)  # Unrounded, so the curve's last point lands on DANGER_TEMP_F.
    span = minutes if minutes >= 0.5 else 10.0  # Already past danger outside: show the first 10 minutes.
    points = [{"minute": round(m, 1), "tempF": round(outside + cabin_rise_f(m), 1)} for m in (0.0, span / 2, span)]
    return {
        "version": 1,
        "source": "databricks forecast",
        "generatedAt": generated_at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "real": False,
        "runs": 0,
        "realRuns": 0,
        "mae": None,
        "evaluation": None,
        "place": worst["city"] + ", FL",
        "headline": {"tempF": round(outside), "timeOfDay": time_of_day_word(worst["local_hour"]),
                     "minutes": round(minutes)},
        "points": points,
        "inputs": {"warmRateFPerMin": round((points[-1]["tempF"] - outside) / span, 2)},
    }

# COMMAND ----------

dbutils.widgets.text("weather_table", "workspace.default.florida_weather_hourly", "Delta table: observed hourly weather")
dbutils.widgets.text("risk_table", "workspace.default.florida_heat_risk_forecast", "Delta table: next-24h hot-car risk")
dbutils.widgets.text("export_path", "/Volumes/workspace/default/echo_logs/florida_insights.json", "Where to write insights.json (empty: print only)")
dbutils.widgets.text("secret_scope", "echo", "Secret scope holding the API key")
dbutils.widgets.text("secret_key", "google_weather_api_key", "Secret name of the API key")
WEATHER_TABLE = dbutils.widgets.get("weather_table").strip()
RISK_TABLE = dbutils.widgets.get("risk_table").strip()
EXPORT_PATH = dbutils.widgets.get("export_path").strip()
API_KEY = dbutils.secrets.get(dbutils.widgets.get("secret_scope").strip(), dbutils.widgets.get("secret_key").strip())

# COMMAND ----------

# MAGIC %md
# MAGIC ## Fetch
# MAGIC Two requests per city (last 24 h, next 24 h). A failed request is reported and skipped so the rest still land;
# MAGIC the run fails at the end (so a scheduled Job shows red) if any request failed.

# COMMAND ----------

import urllib.error

fetched_at = datetime.now(timezone.utc)
observed, forecast, failures = [], [], []
for city, lat, lng in FLORIDA_CITIES:
    for label, url, list_key, out in (("history", HISTORY_URL, "historyHours", observed),
                                      ("forecast", FORECAST_URL, "forecastHours", forecast)):
        try:
            out.extend(hour_row(city, lat, lng, h, fetched_at) for h in fetch_hours(API_KEY, url, list_key, lat, lng))
        except urllib.error.HTTPError as e:
            failures.append("%s %s: HTTP %s %s" % (city, label, e.code, e.read().decode("utf-8", "replace")[:300]))
        except Exception as e:  # Network errors, timeouts, an unexpected response shape.
            failures.append("%s %s: %s" % (city, label, e))

print("Fetched %d observed and %d forecast hourly rows." % (len(observed), len(forecast)))
for f in failures:
    print("FAILED", f)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Observed weather: merge into the growing Delta table
# MAGIC Keyed by `city` + `hour_start_utc`: a re-fetched hour overwrites the earlier copy, a new hour is added.

# COMMAND ----------

from pyspark.sql.types import (
    BooleanType, DoubleType, IntegerType, StringType, StructField, StructType, TimestampType,
)

WEATHER_SCHEMA = StructType([
    StructField("city", StringType(), False),
    StructField("latitude", DoubleType(), False),
    StructField("longitude", DoubleType(), False),
    StructField("hour_start_utc", TimestampType(), False),
    StructField("local_date", StringType(), True),
    StructField("local_hour", IntegerType(), True),
    StructField("is_daytime", BooleanType(), True),
    StructField("condition", StringType(), True),
    StructField("temp_f", DoubleType(), True),
    StructField("feels_like_f", DoubleType(), True),
    StructField("heat_index_f", DoubleType(), True),
    StructField("relative_humidity", IntegerType(), True),
    StructField("uv_index", IntegerType(), True),
    StructField("cloud_cover", IntegerType(), True),
    StructField("fetched_at_utc", TimestampType(), False),
])
RISK_SCHEMA = StructType(WEATHER_SCHEMA.fields + [
    StructField("cabin_10_min_f", DoubleType(), True),
    StructField("cabin_30_min_f", DoubleType(), True),
    StructField("cabin_60_min_f", DoubleType(), True),
    StructField("minutes_to_danger", DoubleType(), True),
    StructField("risk", StringType(), False),
])


def to_df(rows, schema):
    return spark.createDataFrame([[r[f.name] for f in schema.fields] for r in rows], schema)


spark.createDataFrame([], WEATHER_SCHEMA).write.format("delta").mode("ignore").saveAsTable(WEATHER_TABLE)
if observed:
    to_df(observed, WEATHER_SCHEMA).createOrReplaceTempView("weather_batch")
    spark.sql(f"""
        MERGE INTO {WEATHER_TABLE} AS t
        USING weather_batch AS s
        ON t.city = s.city AND t.hour_start_utc = s.hour_start_utc
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
    """)

display(spark.sql(f"""
    SELECT city, count(*) AS hours, min(hour_start_utc) AS first_hour_utc, max(hour_start_utc) AS last_hour_utc,
           max(temp_f) AS max_temp_f, max(heat_index_f) AS max_heat_index_f
    FROM {WEATHER_TABLE} GROUP BY city ORDER BY city
"""))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Hot-car risk, next 24 hours
# MAGIC Every forecast hour with the cabin temperature after 10, 30, and 60 minutes parked, minutes until 104°F,
# MAGIC and a risk level: EXTREME (10 min or less), HIGH (20 or less), ELEVATED (60 or less), WATCH (later), NIGHT
# MAGIC (no sun-driven estimate). This table is overwritten each run; add it to a Databricks dashboard for the map view.

# COMMAND ----------

risk_rows = [add_risk(r) for r in forecast]
if risk_rows:
    to_df(risk_rows, RISK_SCHEMA).write.format("delta").mode("overwrite").option("overwriteSchema", "true") \
        .saveAsTable(RISK_TABLE)

display(spark.sql(f"""
    SELECT city, local_date, local_hour, condition, temp_f, cabin_10_min_f, cabin_30_min_f, minutes_to_danger, risk
    FROM {RISK_TABLE} ORDER BY city, hour_start_utc
"""))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Today's danger windows
# MAGIC Per city: how many forecast hours a parked car reaches 104°F within 20 minutes, the fastest it gets there,
# MAGIC and when.

# COMMAND ----------

display(spark.sql(f"""
    SELECT city,
           count_if(minutes_to_danger <= 20) AS hours_danger_within_20_min,
           min(minutes_to_danger) AS fastest_minutes_to_danger,
           min_by(concat(local_date, ' ', lpad(local_hour, 2, '0'), ':00'), minutes_to_danger) AS fastest_local_hour,
           max(temp_f) AS max_outside_f,
           max(cabin_30_min_f) AS max_cabin_after_30_min_f
    FROM {RISK_TABLE}
    GROUP BY city ORDER BY fastest_minutes_to_danger NULLS LAST
"""))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Export for the app
# MAGIC The worst forecast hour in Florida, in the shape `app/src/insights.js` validates. Copy the printed JSON into
# MAGIC `app/assets/insights.json`.

# COMMAND ----------

insights = forecast_insights(risk_rows, fetched_at)
text = json.dumps(insights, indent=2)
print(text)
if EXPORT_PATH:
    with open(EXPORT_PATH, "w") as f:
        f.write(text + "\n")
    print("Wrote", EXPORT_PATH)

# COMMAND ----------

if failures:
    raise RuntimeError("Weather fetch failed for %d of %d requests: %s"
                       % (len(failures), 2 * len(FLORIDA_CITIES), "; ".join(failures)))
