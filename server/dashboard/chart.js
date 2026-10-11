// Inspect recorded samples only; never interpolate or synthesize a reading.
import { nearestSample } from './view.js';

export function createChartInspector(document) {
  const $ = id => document.getElementById(id);
  const plot = $('curve');
  let curve = { samples: [] }, selectedTime = null, pinned = false;
  function clear() {
    selectedTime = null;
    $('chart-tooltip').hidden = true;
    $('chart-cursor').setAttribute('visibility', 'hidden');
    $('chart-dot').setAttribute('visibility', 'hidden');
  }
  function show(sample) {
    if (!sample) { clear(); return; }
    selectedTime = sample.time;
    const value = `${sample.tempF} °F`;
    const time = new Date(sample.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('tooltip-value').textContent = value;
    $('tooltip-time').textContent = time;
    $('chart-tooltip').hidden = false;
    $('chart-cursor').setAttribute('x1', sample.x);
    $('chart-cursor').setAttribute('x2', sample.x);
    $('chart-cursor').setAttribute('visibility', 'visible');
    $('chart-dot').setAttribute('cx', sample.x);
    $('chart-dot').setAttribute('cy', sample.y);
    $('chart-dot').setAttribute('visibility', 'visible');
    plot.setAttribute('aria-label', `Recorded cabin temperature: ${value}, ${time}. Use arrow keys to inspect readings.`);
  }
  function inspect(event) {
    const rect = plot.getBoundingClientRect();
    if (rect.width > 0) show(nearestSample(curve.samples, (event.clientX - rect.left) / rect.width));
  }
  plot.addEventListener('pointermove', event => { if (!pinned && event.pointerType !== 'touch') inspect(event); });
  plot.addEventListener('pointerdown', event => { pinned = true; inspect(event); });
  plot.addEventListener('pointerleave', () => { if (!pinned) clear(); });
  plot.addEventListener('focus', () => { if (selectedTime === null) show(curve.samples?.at(-1)); });
  plot.addEventListener('blur', () => { pinned = false; clear(); });
  plot.addEventListener('keydown', event => {
    if (event.key === 'Escape') { pinned = false; clear(); return; }
    const samples = curve.samples || [];
    if (!samples.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let index = samples.findIndex(sample => sample.time === selectedTime);
    if (index < 0) index = samples.length - 1;
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = samples.length - 1;
    else index = Math.max(0, Math.min(samples.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)));
    pinned = true; show(samples[index]);
  });
  return {
    update(next) {
      curve = next;
      const hasData = Boolean(curve.samples?.length);
      $('chart-empty').hidden = hasData;
      $('chart-plot').hidden = !hasData;
      $('chart-help').textContent = hasData ? 'Hover or tap a reading · Arrow keys to explore' : 'The chart will appear after the first temperature reading.';
      ['chart-high', 'chart-mid', 'chart-low'].forEach((id, i) => {
        $(id).textContent = hasData ? `${Number(curve.ticks[i].toFixed(1))}°` : '';
      });
      if (selectedTime !== null) {
        const sample = curve.samples?.find(point => point.time === selectedTime);
        if (sample) show(sample);
        else { pinned = false; clear(); }
      }
      if (selectedTime === null) plot.setAttribute('aria-label', 'Recorded cabin temperature over time. Use arrow keys to inspect readings.');
    },
  };
}
