# Databricks notebook source
# MAGIC %md
# MAGIC # Echo heat test: minutes to danger
# MAGIC
# MAGIC Loads the server's status logs, works out how many minutes each moment of a heat test
# MAGIC really was from danger, fits a small model on temperature, humidity, time of day, and
# MAGIC recent warming rate, and shows predicted vs. actual for real heat tests.
# MAGIC
# MAGIC **Insights only.** The output is for the app's Heat insights screen (and the pitch). Nothing here
# MAGIC feeds back into the box's alert levels, the backup ladder, or calls; the box computes its own
# MAGIC `minsToDanger` from its own sensors. This notebook writes nothing that the server or app reads
# MAGIC automatically: its only outputs are cell results and a session-scoped temp view.
# MAGIC
# MAGIC **Uploading logs by hand.** The server writes one log per start to `server/logs/status-<start time>-<pid>.jsonl`
# MAGIC (git-ignored): a `# <ISO receive time>` line, then the status JSON as received, repeated.
# MAGIC 1. Rename each file you upload so its kind is in the name:
# MAGIC    - `real-<date>-<desc>.jsonl` for a **real heat test**: built with `SIMULATE_TEMP` off, temperature from the LM35.
# MAGIC    - `sim-<date>-<desc>.jsonl` for anything else (joystick simulation, replays of synthetic recordings).
# MAGIC    A file is treated as real only if its name has `real` as a whole word (split by `-`, `_`, or `.`).
# MAGIC    Unmarked files count as **not real**.
# MAGIC 2. Upload them to a Unity Catalog Volume (Catalog > your volume > Upload) or DBFS, all in one folder.
# MAGIC 3. Put that folder in the `log_dir` widget (`/Volumes/...` or `/dbfs/...`) and set `timezone` to where the test ran
# MAGIC    (receive times are logged in UTC). Then Run all.
# MAGIC
# MAGIC Only approved status fields are used: `tempF`, `humidity`, and the box's own `minsToDanger` for comparison.
# MAGIC `light` is pending approval and is not used.

# COMMAND ----------

# Plain functions: standard library only, so they can be sanity-checked outside
# Databricks with a local log file.
import json
import math
import os
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

# Danger temperature, the same value the box uses (docs/firmware.md "Minutes to danger").
DANGER_TEMP_F = 104.0
# Window for the recent warming rate, matching the box's 2-minute line fit.
RATE_WINDOW_S = 120.0
# Fewest samples in the window before a rate is computed (about 20 s at the box's 2 s period).
RATE_MIN_SAMPLES = 10

FEATURES = ["tempF", "humidity", "hour_sin", "hour_cos", "warm_rate_f_per_min"]

_REAL_MARKER = re.compile(r"(^|[-_.])real([-_.]|$)", re.IGNORECASE)


def is_real_run(run_name):
    """True only if the file name carries the `real` marker as a whole word."""
    return bool(_REAL_MARKER.search(os.path.basename(run_name)))


def parse_iso(text):
    """Parses the server's `new Date().toISOString()` form, e.g. 2026-10-10T18:04:05.123Z."""
    text = text.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        raise ValueError("receive time has no timezone")
    return dt.astimezone(timezone.utc)


def parse_log_text(text, run):
    """Pairs each `# <ISO time>` line with the JSON line after it.

    Returns (rows, skipped). Each row is the status dict plus `run` and
    `received_at` (aware UTC datetime). `skipped` counts lines that could not be
    used: a bad time line, a JSON line with no time line before it, a time line
    with no JSON after it, or JSON that is not an object.
    """
    rows, skipped = [], 0
    pending_time = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            if pending_time is not None:
                skipped += 1  # time line with no status after it
            try:
                pending_time = parse_iso(line[1:])
            except ValueError:
                pending_time = None
                skipped += 1
            continue
        if pending_time is None:
            skipped += 1
            continue
        try:
            status = json.loads(line)
        except ValueError:
            status = None
        if not isinstance(status, dict):
            skipped += 1
        else:
            row = dict(status)
            row["run"] = run
            row["received_at"] = pending_time
            rows.append(row)
        pending_time = None
    if pending_time is not None:
        skipped += 1
    return rows, skipped


def _num(value):
    """A finite float, or None (null, missing, bool, or not a number)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def add_time_of_day(rows, tz_name):
    """Adds local `hour` (fraction, 0-24), `hour_sin`, `hour_cos`."""
    tz = ZoneInfo(tz_name)
    for row in rows:
        local = row["received_at"].astimezone(tz)
        hour = local.hour + local.minute / 60.0 + local.second / 3600.0
        row["hour"] = hour
        row["hour_sin"] = math.sin(2 * math.pi * hour / 24.0)
        row["hour_cos"] = math.cos(2 * math.pi * hour / 24.0)
    return rows


def _slope_per_min(points):
    """Least-squares slope of (seconds, tempF) points, in degrees F per minute."""
    n = len(points)
    mean_x = sum(p[0] for p in points) / n
    mean_y = sum(p[1] for p in points) / n
    sxx = sum((p[0] - mean_x) ** 2 for p in points)
    if sxx == 0:
        return None
    sxy = sum((p[0] - mean_x) * (p[1] - mean_y) for p in points)
    return sxy / sxx * 60.0


def add_run_features(rows):
    """Per run, in receive order: the recent warming rate and the actual minutes to danger.

    - `warm_rate_f_per_min`: slope of tempF over the run's own rows received in the
      last RATE_WINDOW_S seconds (this row included); None with fewer than
      RATE_MIN_SAMPLES readings.
    - `actual_mins_to_danger`: minutes from this row's receive time until the run's
      tempF first reaches DANGER_TEMP_F; 0 on that row; None after it, and None for
      every row of a run that never reaches it.
    Rows are sorted by (run, received_at) in place.
    """
    rows.sort(key=lambda r: (r["run"], r["received_at"]))
    by_run = {}
    for row in rows:
        row["tempF"] = _num(row.get("tempF"))
        row["humidity"] = _num(row.get("humidity"))
        row["minsToDanger"] = _num(row.get("minsToDanger"))
        by_run.setdefault(row["run"], []).append(row)

    for run_rows in by_run.values():
        start = run_rows[0]["received_at"]
        secs = [(r["received_at"] - start).total_seconds() for r in run_rows]

        lo = 0
        for i, row in enumerate(run_rows):
            while secs[i] - secs[lo] >= RATE_WINDOW_S:
                lo += 1
            pts = [(secs[j], run_rows[j]["tempF"]) for j in range(lo, i + 1)
                   if run_rows[j]["tempF"] is not None]
            row["warm_rate_f_per_min"] = _slope_per_min(pts) if len(pts) >= RATE_MIN_SAMPLES else None

        hit = next((i for i, r in enumerate(run_rows)
                    if r["tempF"] is not None and r["tempF"] >= DANGER_TEMP_F), None)
        for i, row in enumerate(run_rows):
            row["reaches_danger"] = hit is not None
            row["actual_mins_to_danger"] = (secs[hit] - secs[i]) / 60.0 if hit is not None and i <= hit else None
    return rows


def load_logs(paths, tz_name):
    """Reads every path, returns (rows, skipped_by_file)."""
    rows, skipped = [], {}
    for path in sorted(paths):
        with open(path, encoding="utf-8", errors="replace") as f:
            file_rows, n_bad = parse_log_text(f.read(), os.path.basename(path))
        skipped[os.path.basename(path)] = n_bad
        rows.extend(file_rows)
    for row in rows:
        row["is_real"] = is_real_run(row["run"])
    add_time_of_day(rows, tz_name)
    add_run_features(rows)
    return rows, skipped


def time_of_day_word(hour):
    if 5 <= hour < 12:
        return "morning"
    if 12 <= hour < 17:
        return "afternoon"
    if 17 <= hour < 21:
        return "evening"
    return "night"


def insight_sentence(temp_f, hour, minutes, real):
    sentence = f"On a {temp_f:.0f}°F {time_of_day_word(hour)}, your car hits danger in {minutes:.0f} minutes"
    return sentence if real else sentence + " (not from a real heat test)"

# COMMAND ----------

dbutils.widgets.text("log_dir", "/Volumes/main/default/echo_logs", "Folder with uploaded .jsonl logs")
dbutils.widgets.text("timezone", "UTC", "Timezone where the test ran (IANA, e.g. America/Los_Angeles)")
LOG_DIR = dbutils.widgets.get("log_dir").strip()
TZ_NAME = dbutils.widgets.get("timezone").strip() or "UTC"
print(f"log_dir = {LOG_DIR}\ntimezone = {TZ_NAME}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Parse
# MAGIC Every `.jsonl` file in `log_dir` is one run, named by its file name (`run`). Each status keeps its
# MAGIC receive time from the `#` line before it; time of day comes from that, in the `timezone` widget's zone.

# COMMAND ----------

import glob

import pandas as pd

log_paths = glob.glob(os.path.join(LOG_DIR, "*.jsonl"))
if not log_paths:
    raise FileNotFoundError(f"No .jsonl files in {LOG_DIR}. Upload logs there or change the log_dir widget.")

rows, skipped_by_file = load_logs(log_paths, TZ_NAME)
pdf = pd.DataFrame(rows)
pdf["received_at"] = pd.to_datetime(pdf["received_at"], utc=True)

print(f"{len(log_paths)} files, {len(pdf)} statuses parsed, {sum(skipped_by_file.values())} lines skipped")
for name, n_bad in skipped_by_file.items():
    if n_bad:
        print(f"  {name}: {n_bad} malformed lines skipped")

# Session-scoped view so the data can be queried with SQL in this notebook; nothing persistent is written.
table_cols = ["run", "is_real", "received_at", "hour", "state", "tempF", "humidity", "minsToDanger",
              "warm_rate_f_per_min", "actual_mins_to_danger"]
table_cols = [c for c in table_cols if c in pdf.columns]
spark.createDataFrame(pdf[table_cols]).createOrReplaceTempView("echo_status")
display(spark.table("echo_status"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Real vs. simulated runs
# MAGIC A run counts as a real heat test only when its file name has the `real` marker (see the top cell).
# MAGIC The status JSON does not say whether `SIMULATE_TEMP` was on, so the name is the only signal.

# COMMAND ----------

runs = (pdf.groupby("run")
        .agg(is_real=("is_real", "first"), statuses=("tempF", "size"),
             start=("received_at", "min"), end=("received_at", "max"),
             min_tempF=("tempF", "min"), max_tempF=("tempF", "max"),
             reaches_danger=("reaches_danger", "first"))
        .reset_index())
runs["minutes"] = (runs["end"] - runs["start"]).dt.total_seconds() / 60.0
display(runs)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Guard: is there a real heat test?

# COMMAND ----------

real_runs = sorted(runs.loc[runs["is_real"] & runs["reaches_danger"], "run"])
HAS_REAL = bool(real_runs)
if HAS_REAL:
    print(f"Real heat tests that reach {DANGER_TEMP_F:.0f}°F: {', '.join(real_runs)}")
else:
    print("=" * 72)
    print(f"NO REAL HEAT TEST reaching {DANGER_TEMP_F:.0f}°F is loaded.")
    print("Everything below is computed from simulated or unmarked runs and is")
    print("NOT FROM A REAL HEAT TEST. Do not quote these numbers as real results.")
    print("=" * 72)
RESULT_LABEL = "real heat test" if HAS_REAL else "NOT from a real heat test"

# COMMAND ----------

# MAGIC %md
# MAGIC ## Actual minutes to danger
# MAGIC For every status, `actual_mins_to_danger` is the elapsed time from that status's receive time until the
# MAGIC run's `tempF` **first** reaches 104°F (0 on that status). It is empty after that point, and for every status of a
# MAGIC run that never gets there.
# MAGIC
# MAGIC This is hindsight and differs from the box's live `minsToDanger`: the box only knows the past 2 minutes and
# MAGIC projects a straight line `(104 − current °F) ÷ warming rate` (null below 0.05°F/min). Real cabins warm along a
# MAGIC curve, so the box's estimate drifts from what actually happens; this column is what actually happened.

# COMMAND ----------

# MAGIC %md
# MAGIC ## Features and model
# MAGIC Features per status: `tempF`, `humidity`, time of day as `hour_sin`/`hour_cos` (so 23:59 sits next to 00:00),
# MAGIC and `warm_rate_f_per_min`, the least-squares slope of `tempF` over the run's own statuses received in the last
# MAGIC **2 minutes** (at least 10 readings). Target: `actual_mins_to_danger`.
# MAGIC
# MAGIC Model: ordinary linear regression, so each feature's effect is one readable coefficient. Training uses only runs
# MAGIC that reach danger, and statuses before the crossing. Evaluation is **held out by run**: each evaluated run is
# MAGIC predicted by a model fit on all the other runs. With only one usable run there is nothing to hold out, and the
# MAGIC results are labelled in-sample. Simulated runs warm far faster than a real cabin (up to 30°F/min with the joystick),
# MAGIC so a model fit mostly on them extrapolates badly to real tests; more real runs fix that.

# COMMAND ----------

import numpy as np
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error

train_pdf = pdf.dropna(subset=FEATURES + ["actual_mins_to_danger"]).copy()
usable_runs = sorted(train_pdf["run"].unique())
if not usable_runs:
    raise ValueError("No run reaches danger with enough readings to fit. Upload a run that reaches 104°F.")

eval_runs = [r for r in real_runs if r in usable_runs] or usable_runs
IN_SAMPLE = len(usable_runs) < 2
preds = []
for run in eval_runs:
    test = train_pdf[train_pdf["run"] == run]
    train = train_pdf if IN_SAMPLE else train_pdf[train_pdf["run"] != run]
    model = LinearRegression().fit(train[FEATURES], train["actual_mins_to_danger"])
    out = test[["run", "is_real", "received_at", "tempF", "humidity", "hour", "warm_rate_f_per_min",
                "minsToDanger", "actual_mins_to_danger"]].copy()
    out["predicted_mins_to_danger"] = np.clip(model.predict(test[FEATURES]), 0, None)
    preds.append(out)
pred_pdf = pd.concat(preds, ignore_index=True)

final_model = LinearRegression().fit(train_pdf[FEATURES], train_pdf["actual_mins_to_danger"])
print(f"Fit on {len(train_pdf)} statuses from {len(usable_runs)} runs; evaluated: {', '.join(eval_runs)}")
print("Coefficients (minutes per unit):")
for name, coef in zip(FEATURES, final_model.coef_):
    print(f"  {name:>22}: {coef:+.3f}")
print(f"  {'intercept':>22}: {final_model.intercept_:+.3f}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Predicted vs. actual

# COMMAND ----------

import matplotlib.pyplot as plt

how = "in-sample, only one usable run" if IN_SAMPLE else "held out by run"
mae = mean_absolute_error(pred_pdf["actual_mins_to_danger"], pred_pdf["predicted_mins_to_danger"])
print(f"[{RESULT_LABEL}] model MAE: {mae:.2f} min over {len(pred_pdf)} statuses ({how})")
box = pred_pdf.dropna(subset=["minsToDanger"])
if len(box):
    box_mae = mean_absolute_error(box["actual_mins_to_danger"], box["minsToDanger"])
    print(f"[{RESULT_LABEL}] box live estimate MAE: {box_mae:.2f} min over {len(box)} statuses where it was not null")
display(pred_pdf)

fig, ax = plt.subplots(figsize=(6, 6))
for run, grp in pred_pdf.groupby("run"):
    ax.scatter(grp["actual_mins_to_danger"], grp["predicted_mins_to_danger"], s=12, label=run)
top = float(max(pred_pdf["actual_mins_to_danger"].max(), pred_pdf["predicted_mins_to_danger"].max(), 1.0))
ax.plot([0, top], [0, top], "k--", linewidth=1, label="perfect")
ax.set_xlabel("actual minutes to 104°F")
ax.set_ylabel("predicted minutes to 104°F")
ax.set_title(f"Minutes to danger ({RESULT_LABEL}, {how})\nMAE {mae:.1f} min")
ax.legend(fontsize=7)
display(fig)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Heat insights sentence
# MAGIC The kind of line the app's Heat insights screen shows. Printed only: copy it into the app by hand.
# MAGIC It uses the first evaluated status of each run (the start of the heat test).

# COMMAND ----------

for run, grp in pred_pdf.groupby("run"):
    first = grp.sort_values("received_at").iloc[0]
    print(insight_sentence(first["tempF"], first["hour"], first["predicted_mins_to_danger"], bool(first["is_real"])))
    print(f"    ({run}: actual {first['actual_mins_to_danger']:.1f} min)")
