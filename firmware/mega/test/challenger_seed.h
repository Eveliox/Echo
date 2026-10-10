// Challenger seed scenarios (#22), graded offline by logic-test through the
// same parser and runner (challenger.h) as generated scenarios.
//
// EXPECTED VALUES PENDING HUMAN REVIEW (David) against the level table,
// "Leaving a level", "Seat detection", and "Minutes to danger" in
// docs/firmware.md; see #22. Each `expected` was written from the doc, not
// from running logic.h. If a seed and logic.h disagree, check the doc before
// changing either one.
//
// Mapping (challenger.h): one element per 2 s status period, ignition off and
// cancel not pressed throughout; the level after the last element counts.
// Fields: name, expected, presence (0/1 per period), tempF (comma-separated).

#ifndef ECHO_CHALLENGER_SEED_H
#define ECHO_CHALLENGER_SEED_H

struct ChallengerSeed {
  const char *name;
  const char *expected;
  const char *presence;
  const char *tempF;
};

static const ChallengerSeed CHALLENGER_SEEDS[] = {
    // 20 periods. level table: OCCUPANT needs the seat occupied for 30 s; WARNING/EMERGENCY need OCCUPANT first. Never occupied, so 110F still stays ARMED.
    {"empty seat, hot cabin", "ARMED",
     "0000000000"
     "0000000000",
     "110,110,110,110,110,110,110,110,110,110,110,110,"
     "110,110,110,110,110,110,110,110"},
    // 15 periods. level table: OCCUPANT is "seat occupied for 30 s"; 15 periods occupied span 0..28 s.
    {"occupied 28 s, under the dwell", "ARMED",
     "1111111111"
     "11111",
     "80,80,80,80,80,80,80,80,80,80,80,80,"
     "80,80,80"},
    // 19 periods. level table: "Armed and seat occupied for 30 s"; occupied from 6 s to 36 s.
    {"occupied exactly 30 s after empty start", "OCCUPANT",
     "0001111111"
     "111111111",
     "80,80,80,80,80,80,80,80,80,80,80,80,"
     "80,80,80,80,80,80,80"},
    // 18 periods. level table: WARNING is "Occupant and 95F (35C) or more".
    {"occupant then 95F", "WARNING",
     "1111111111"
     "11111111",
     "80,80,80,80,80,80,80,80,80,80,80,80,"
     "80,80,80,80,95,95"},
    // 17 periods. level table: EMERGENCY is "Occupant and 104F (40C) or more" (straight from OCCUPANT).
    {"occupant then 104F", "EMERGENCY",
     "1111111111"
     "1111111",
     "80,80,80,80,80,80,80,80,80,80,80,80,"
     "80,80,80,80,104"},
    // 19 periods. level table: WARNING needs 95F "or more"; 94.9 is below, and minutes to danger is null with under 60 samples.
    {"occupant at 94.9F", "OCCUPANT",
     "1111111111"
     "111111111",
     "80,80,80,80,80,80,80,80,80,80,80,80,"
     "80,80,80,80,94.9,94.9,94.9"},
    // 60 periods. "Minutes to danger": after 60 samples (2 min) the fit gives 1.2F/min; (104-92.36)/1.2 = 9.7 min, "10 min or less" -> WARNING at 92.36F.
    {"warming 1.2F/min, warning by minutes below 95F", "WARNING",
     "1111111111"
     "1111111111"
     "1111111111"
     "1111111111"
     "1111111111"
     "1111111111",
     "90,90.04,90.08,90.12,90.16,90.2,90.24,90.28,90.32,90.36,90.4,90.44,"
     "90.48,90.52,90.56,90.6,90.64,90.68,90.72,90.76,90.8,90.84,90.88,90.92,"
     "90.96,91,91.04,91.08,91.12,91.16,91.2,91.24,91.28,91.32,91.36,91.4,"
     "91.44,91.48,91.52,91.56,91.6,91.64,91.68,91.72,91.76,91.8,91.84,91.88,"
     "91.92,91.96,92,92.04,92.08,92.12,92.16,92.2,92.24,92.28,92.32,92.36"},
    // 60 periods. "Minutes to danger": 3F/min at 90.9F gives (104-90.9)/3 = 4.4 min, "5 min or less" -> EMERGENCY.
    {"warming 3F/min, emergency by minutes below 95F", "EMERGENCY",
     "1111111111"
     "1111111111"
     "1111111111"
     "1111111111"
     "1111111111"
     "1111111111",
     "85,85.1,85.2,85.3,85.4,85.5,85.6,85.7,85.8,85.9,86,86.1,"
     "86.2,86.3,86.4,86.5,86.6,86.7,86.8,86.9,87,87.1,87.2,87.3,"
     "87.4,87.5,87.6,87.7,87.8,87.9,88,88.1,88.2,88.3,88.4,88.5,"
     "88.6,88.7,88.8,88.9,89,89.1,89.2,89.3,89.4,89.5,89.6,89.7,"
     "89.8,89.9,90,90.1,90.2,90.3,90.4,90.5,90.6,90.7,90.8,90.9"},
    // 70 periods. "Minutes to danger": rate 0.03F/min is below 0.05, so the value is null; 80F is under 95F.
    {"slow warming below 0.05F/min", "OCCUPANT",
     "1111111111"
     "1111111111"
     "1111111111"
     "1111111111"
     "1111111111"
     "1111111111"
     "1111111111",
     "80,80.001,80.002,80.003,80.004,80.005,80.006,80.007,80.008,80.009,80.01,80.011,"
     "80.012,80.013,80.014,80.015,80.016,80.017,80.018,80.019,80.02,80.021,80.022,80.023,"
     "80.024,80.025,80.026,80.027,80.028,80.029,80.03,80.031,80.032,80.033,80.034,80.035,"
     "80.036,80.037,80.038,80.039,80.04,80.041,80.042,80.043,80.044,80.045,80.046,80.047,"
     "80.048,80.049,80.05,80.051,80.052,80.053,80.054,80.055,80.056,80.057,80.058,80.059,"
     "80.06,80.061,80.062,80.063,80.064,80.065,80.066,80.067,80.068,80.069"},
    // 28 periods. "Leaving a level": once WARNING starts it stays even if the temperature drops.
    {"cooling after warning", "WARNING",
     "1111111111"
     "1111111111"
     "11111111",
     "80,80,80,80,80,80,80,80,80,80,80,80,"
     "80,80,80,80,96,96,94,93,92,91,90,89,"
     "88,87,86,85"},
    // 26 periods. "Leaving a level": levels only climb on their own; only cancel or ignition lowers one (logic.h pins OCCUPANT as sticky too).
    {"seat empties after occupant", "OCCUPANT",
     "1111111111"
     "1111110000"
     "000000",
     "80,80,80,80,80,80,80,80,80,80,80,80,"
     "80,80,80,80,80,80,80,80,80,80,80,80,"
     "80,80"},
    // 21 periods. level table: "occupied for 30 s" means without a break; 18 s, one empty period, then 18 s.
    {"brief seat blip restarts the dwell", "ARMED",
     "1111111111"
     "0111111111"
     "1",
     "80,80,80,80,80,80,80,80,80,80,80,80,"
     "80,80,80,80,80,80,80,80,80"},
    // 20 periods. Seat detection is by distance only, so a bag reads as occupied (brief: "Bag vs. person ... both read as occupied"); the box cannot tell them apart.
    {"bag on the seat", "OCCUPANT",
     "1111111111"
     "1111111111",
     "80,80,80,80,80,80,80,80,80,80,80,80,"
     "80,80,80,80,80,80,80,80"},
    // 20 periods. level table: OCCUPANT after 30 s, and "Occupant and 95F or more" -> WARNING in that same period.
    {"already hot when the dwell ends", "WARNING",
     "1111111111"
     "1111111111",
     "100,100,100,100,100,100,100,100,100,100,100,100,"
     "100,100,100,100,100,100,100,100"},
    // 27 periods. "Leaving a level": EMERGENCY stays even if the temperature drops or the seat reads empty.
    {"emergency then cooling and empty seat", "EMERGENCY",
     "1111111111"
     "1111111000"
     "0000000",
     "80,80,80,80,80,80,80,80,80,80,80,80,"
     "80,80,80,80,105,90,90,90,90,90,90,90,"
     "90,90,90"},
};

static const int CHALLENGER_SEED_COUNT = (int)(sizeof CHALLENGER_SEEDS / sizeof CHALLENGER_SEEDS[0]);

#endif  // ECHO_CHALLENGER_SEED_H
