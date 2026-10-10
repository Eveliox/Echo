// A fake clock and setTimeout/clearTimeout for ladder tests, so they never
// wait in real time. Not a test file itself (the Checks glob is *.test.js).

export const settle = () => new Promise((resolve) => setImmediate(resolve));

export function createFakeClock(start = Date.parse('2026-10-10T20:00:00.000Z')) {
  let t = start;
  let nextId = 1;
  const pending = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) {
        const id = nextId++;
        pending.set(id, { id, at: t + ms, fn });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    pending: () => pending.size,
    // Moves time forward by `ms`, firing due timers in time order and letting
    // promises settle after each one.
    async advance(ms) {
      const until = t + ms;
      await settle(); // what is already due now settles before time moves
      for (;;) {
        const due = [...pending.values()]
          .filter((p) => p.at <= until)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        pending.delete(due.id);
        t = due.at;
        due.fn();
        await settle();
      }
      t = until;
      await settle();
    },
  };
}
