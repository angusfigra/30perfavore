// ============================================================================
// STEP SEQUENCER — Web Audio API
// ============================================================================
// This file implements a multi-track step sequencer using the Web Audio API.
// Key concepts demonstrated:
//   • OscillatorNode for waveform generation (sine, square, sawtooth, triangle)
//   • GainNode for volume envelopes (attack/decay)
//   • AnalyserNode for real-time FFT spectral analysis
//   • DelayNode for phase-shifting oscillators (since OscillatorNode has no
//     native phase property)
//   • Lookahead scheduling pattern (setInterval + audioContext.currentTime)
//   • AudioBuffer + BufferSourceNode for white noise synthesis
// ============================================================================

// ─── Track State Variables ──────────────────────────────────────────────────

// The sequencer starts with 5 independent tracks, but the user can add more.
let numTracks = 5;

// Default frequencies for the first five tracks (in Hz).
// If a user adds track 6, we'll assign a default like 880 Hz.
let TRACK_FREQ = [220, 330, 440, 550, 660];

// ─── Audio Context ──────────────────────────────────────────────────────────

// The AudioContext is the central "hub" that owns all audio nodes and manages
// the audio rendering pipeline. We use the vendor-prefixed version as a
// fallback for older WebKit browsers (Safari ≤ 13).
const ctx = new (window.AudioContext || window.webkitAudioContext)();

// ─── Analyser Node (persistent, shared) ─────────────────────────────────────

// An AnalyserNode performs real-time FFT analysis of the audio passing
// through it. We create it once and reuse it for the spectrometer canvas.
const analyser = ctx.createAnalyser();

// fftSize determines the frequency resolution: 4096 samples → 2048 bins.
// Higher values give finer resolution but cost more CPU.
analyser.fftSize = 4096;

// smoothingTimeConstant (0–1) controls how much the previous FFT frame
// blends into the current one. 0.78 gives a nice smooth, non-jumpy display.
analyser.smoothingTimeConstant = 0.78;

// Connect the analyser to the audio output (speakers). Every sound we play
// will pass through the analyser first, which taps the signal for analysis
// before forwarding it to the destination.
analyser.connect(ctx.destination);

// ─── State Variables ────────────────────────────────────────────────────────

// numSteps: the number of steps in the sequence. Default 16 (like a classic
// 4/4 pattern with 16th-note subdivisions). The user can change this via the
// "Steps" number input (1–64).
let numSteps = 16;

// selTrack: the index (0–4+) of the currently-selected track whose parameters
// are shown in the sliders panel.
let selTrack = 0;

// playing: true when the sequencer is running, false when stopped.
let playing = false;

// curStep: the index of the next step to be scheduled. Advances 0 → numSteps−1
// and wraps around.
let curStep = 0;

// nextStepTime: the audioContext.currentTime at which the next step should be
// scheduled. This is the core of the lookahead scheduling pattern.
let nextStepTime = 0;

// schedHandle: the ID returned by setInterval() so we can clear it on stop.
let schedHandle = null;

// ─── Track Parameters ───────────────────────────────────────────────────────

// tParams is an array of objects, one per track. Each object stores the
// current mix levels, phase offsets, ADSR envelope, frequency, track volume,
// and advanced pitch properties (per-step pitch, glissando).
let tParams = Array.from({ length: numTracks }, (_, i) => ({
  sine:   0.5,   // volume of the sine waveform (0–1)
  square: 0,     // volume of the square waveform (0–1)
  saw:    0,     // volume of the sawtooth waveform (0–1)
  tri:    0,     // volume of the triangle waveform (0–1)
  noise:  0,     // volume of white noise (0–1)
  // ADSR envelope parameters:
  attack:  0.01,  // attack time in seconds (ramp from silence to peak)
  decay:   0.3,   // decay time in seconds (ramp from peak to sustain level)
  sustain: 0.5,   // sustain level as a fraction of peak volume (0–1)
  release: 0.3,   // release time in seconds (fade from sustain to silence)
  freq:   TRACK_FREQ[i],  // fundamental base frequency in Hz
  vol:    1.0,   // overall track volume (0–1), controlled by the in-grid slider
  // Phase offsets in degrees (0–360) for each waveform type.
  phaseSine:   0,
  phaseSquare: 0,
  phaseSaw:    0,
  phaseTri:    0,
  // Advanced Pitch controls:
  perStepPitch: false, // if true, reads from stepFreqs instead of base freq
  glissando:    false, // if true, pitch bends during the release phase
  glissCents:   100,   // pitch bend amount in cents (1200 cents = 1 octave)
  glissDir:     'up',  // pitch bend direction: 'up' or 'down'
  stepFreqs:    new Array(16).fill(TRACK_FREQ[i]), // individual Hz per step
  stepEdited:   new Array(16).fill(false) // tracks which steps have been explicitly edited
}));

// tGrid stores the on/off pattern for each track. It is a 2D array:
// tGrid[trackIndex][stepIndex] = true if that step is active (will trigger).
let tGrid = Array.from({ length: numTracks }, () => []);

// selectedStep tracks which step is currently selected for per-step pitch editing.
// null when no step is selected; { track, step } when editing.
let selectedStep = null;

// ─── Grid: Build & Render ───────────────────────────────────────────────────

/**
 * deleteTrack(t) removes the given track index from the sequencer state.
 */
function deleteTrack(t) {
  // Prevent deleting the very last track
  if (numTracks <= 1) {
    alert("You must have at least one track.");
    return;
  }
  
  // Remove track data from all state arrays
  tParams.splice(t, 1);
  tGrid.splice(t, 1);
  TRACK_FREQ.splice(t, 1);
  numTracks--;
  
  // Handle selTrack if the deleted track was selected, or shifted
  if (selTrack === t) {
    selTrack = Math.max(0, selTrack - 1);
    loadSliders();
  } else if (selTrack > t) {
    selTrack--;
  }
  
  // Re-render and update UI
  document.getElementById('lblTrack').textContent = selTrack + 1;
  document.querySelectorAll('.lbl-track-mirror').forEach(el => {
    el.textContent = selTrack + 1;
  });
  
  renderGrid();
  drawWave();
}

/**
 * addTrack() appends a new track to the sequencer.
 */
function addTrack() {
  const newIdx = numTracks;
  numTracks++;
  
  // Assign a default frequency (e.g. octave higher than track 0, or just 880)
  const defaultFreq = 880;
  TRACK_FREQ.push(defaultFreq);
  
  // Create default parameters
  tParams.push({
    sine:   0.5,
    square: 0,
    saw:    0,
    tri:    0,
    noise:  0,
    attack:  0.01,
    decay:   0.3,
    sustain: 0.5,
    release: 0.3,
    freq:   defaultFreq,
    vol:    1.0,
    phaseSine:   0,
    phaseSquare: 0,
    phaseSaw:    0,
    phaseTri:    0,
    perStepPitch: false,
    glissando:    false,
    glissCents:   100,
    glissDir:     'up',
    stepFreqs:    new Array(numSteps).fill(defaultFreq),
    stepEdited:   new Array(numSteps).fill(false)
  });
  
  // Create an empty grid row
  tGrid.push(new Array(numSteps).fill(false));
  
  // Re-render the grid
  renderGrid();
}

/**
 * rebuildGrid() reads the desired number of steps from the HTML number input,
 * resizes every track's step array (preserving any existing checked steps),
 * and then calls renderGrid() to recreate the DOM checkboxes.
 */
function rebuildGrid() {
  const raw = parseInt(document.getElementById('inpSteps').value, 10) || 16;
  numSteps = Math.max(1, Math.min(64, raw));

  tGrid = tGrid.map(row => {
    const next = new Array(numSteps).fill(false);
    for (let i = 0; i < Math.min(row.length, numSteps); i++) {
      next[i] = row[i];
    }
    return next;
  });

  // Also resize the stepFreqs and stepEdited arrays for each track
  tParams.forEach(p => {
    const nextFreqs = new Array(numSteps).fill(p.freq);
    const nextEdited = new Array(numSteps).fill(false);
    for (let i = 0; i < Math.min(p.stepFreqs.length, numSteps); i++) {
      nextFreqs[i] = p.stepFreqs[i];
      nextEdited[i] = p.stepEdited[i];
    }
    p.stepFreqs = nextFreqs;
    p.stepEdited = nextEdited;
  });

  renderGrid();
}

/**
 * renderGrid() clears the #grid element and builds fresh HTML for each track.
 */
function renderGrid() {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';

  for (let t = 0; t < numTracks; t++) {
    const row = document.createElement('div');
    row.className = 'grid-row';

    // ── Track Controls Container ──
    const controls = document.createElement('div');
    controls.className = 'track-controls';

    // Radio button
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'selTrack';
    radio.id = 'rt' + t;
    if (t === selTrack) radio.checked = true;

    radio.addEventListener('change', () => {
      selTrack = t;
      loadSliders();
      document.getElementById('lblTrack').textContent = t + 1;
      document.querySelectorAll('.lbl-track-mirror').forEach(el => {
        el.textContent = t + 1;
      });
      drawWave();
    });

    // Label
    const lbl = document.createElement('label');
    lbl.htmlFor = 'rt' + t;
    lbl.textContent = 'T' + (t + 1);

    // Volume slider
    const volSl = document.createElement('input');
    volSl.type = 'range';
    volSl.min = '0';
    volSl.max = '1';
    volSl.step = '0.01';
    volSl.value = tParams[t].vol;
    volSl.title = 'Track ' + (t + 1) + ' volume';

    volSl.addEventListener('input', e => {
      tParams[t].vol = parseFloat(e.target.value);
    });
    volSl.addEventListener('mouseup', () => volSl.blur());

    // Delete Button
    const btnDelete = document.createElement('button');
    btnDelete.type = 'button';
    btnDelete.className = 'btn-delete-track';
    btnDelete.textContent = '✕';
    btnDelete.title = 'Delete Track ' + (t + 1);
    btnDelete.addEventListener('click', () => deleteTrack(t));

    controls.appendChild(radio);
    controls.appendChild(lbl);
    controls.appendChild(volSl);
    controls.appendChild(btnDelete);
    row.appendChild(controls);

    // ── Step Cells ──
    for (let s = 0; s < numSteps; s++) {
      const cell = document.createElement('div');
      cell.className = 'step-cell';

      // The standard checkbox
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = 'cb' + t + '_' + s;
      cb.checked = tGrid[t][s];

      // If this is the currently selected step for per-step editing, highlight it
      if (selectedStep && selectedStep.track === t && selectedStep.step === s) {
        cb.classList.add('step-selected');
      }

      cb.addEventListener('click', e => {
        // Shift+Click selects a step for per-step pitch editing (without toggling)
        if (e.shiftKey && tParams[t].perStepPitch && tGrid[t][s]) {
          e.preventDefault(); // Don't toggle the checkbox
          selectStepForEditing(t, s);
          return;
        }
      });

      cb.addEventListener('change', e => {
        tGrid[t][s] = e.target.checked;
        // If a step is unchecked and it was the selected step, deselect it
        if (!e.target.checked && selectedStep &&
            selectedStep.track === t && selectedStep.step === s) {
          deselectStep();
        }
      });
      
      cell.appendChild(cb);
      row.appendChild(cell);
    }

    grid.appendChild(row);
  }
}

// ─── Slider Loading & Saving ────────────────────────────────────────────────

/**
 * loadSliders() reads the parameter object for the currently-selected track
 * and sets the HTML slider/input values to match. This is called when the
 * user switches tracks via the radio buttons.
 */
function loadSliders() {
  const p = tParams[selTrack];

  document.getElementById('slSine').value     = p.sine;
  document.getElementById('slSquare').value   = p.square;
  document.getElementById('slSaw').value      = p.saw;
  document.getElementById('slTri').value      = p.tri;
  document.getElementById('slNoise').value    = p.noise;

  // ADSR envelope sliders.
  document.getElementById('slAttack').value   = p.attack;
  document.getElementById('slDecay').value    = p.decay;
  document.getElementById('slSustain').value  = p.sustain;
  document.getElementById('slRelease').value  = p.release;

  document.getElementById('slFreq').value     = p.freq;
  document.getElementById('inpHz').value      = p.freq;

  // Phase sliders (0–360 degrees).
  document.getElementById('slPhaseSine').value   = p.phaseSine;
  document.getElementById('slPhaseSquare').value = p.phaseSquare;
  document.getElementById('slPhaseSaw').value    = p.phaseSaw;
  document.getElementById('slPhaseTri').value    = p.phaseTri;

  // Per-Step Pitch toggle.
  document.getElementById('chkPerStep').checked = p.perStepPitch;

  // Glissando controls.
  document.getElementById('chkGliss').checked = p.glissando;
  document.getElementById('inpGliss').value   = p.glissCents;
  document.getElementById('inpGliss').disabled = !p.glissando;
  document.getElementById('selGlissDir').value = p.glissDir;
  document.getElementById('selGlissDir').disabled = !p.glissando;

  // Update the value display spans next to each slider.
  updateAllDisplays();

  // Try to match the frequency to a standard piano note.
  syncNoteSelector(p.freq);

  // Deselect any per-step selection when switching tracks.
  deselectStep();
}

/**
 * syncNoteSelector() finds the piano note whose frequency is closest to the
 * given freq. If within 0.5 Hz, it selects that note; otherwise clears it.
 * This gives the user visual feedback when they're on a standard pitch.
 */
function syncNoteSelector(freq) {
  const sel = document.getElementById('selNote');
  let bestOpt = '';         // the value of the closest matching option
  let bestDiff = Infinity;  // the smallest difference found so far

  // Iterate through every <option> in the note selector.
  for (const opt of sel.options) {
    if (!opt.value) continue;  // skip the blank "—" option

    // Compare the option's frequency to the target.
    const diff = Math.abs(parseFloat(opt.value) - freq);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestOpt = opt.value;
    }
  }

  // Only snap to a note if we're within 0.5 Hz — otherwise leave blank,
  // indicating the frequency doesn't correspond to a standard piano key.
  sel.value = bestDiff < 0.5 ? bestOpt : '';
}

/**
 * saveSliders() reads all slider values from the DOM and writes them into the
 * tParams object for the currently-selected track. Called on every 'input'
 * event from the sliders. Also triggers a waveform redraw.
 */
function saveSliders() {
  // Get the parameter object for the active track.
  const p = tParams[selTrack];

  // ── Read waveform volume sliders ──
  p.sine   = parseFloat(document.getElementById('slSine').value);
  p.square = parseFloat(document.getElementById('slSquare').value);
  p.saw    = parseFloat(document.getElementById('slSaw').value);
  p.tri    = parseFloat(document.getElementById('slTri').value);
  p.noise  = parseFloat(document.getElementById('slNoise').value);

  // ── Read ADSR envelope sliders ──
  p.attack  = parseFloat(document.getElementById('slAttack').value);
  p.decay   = parseFloat(document.getElementById('slDecay').value);
  p.sustain = parseFloat(document.getElementById('slSustain').value);
  p.release = parseFloat(document.getElementById('slRelease').value);

  // ── Read frequency slider and sync the number input ──
  const newFreq = parseFloat(document.getElementById('slFreq').value);
  const freqChanged = (newFreq !== p.freq);
  p.freq = newFreq;
  document.getElementById('inpHz').value = p.freq;

  // If the base frequency changed, propagate to non-edited steps.
  if (freqChanged) {
    propagateBaseFreq(p);
  }

  // ── Read phase sliders (degrees) ──
  p.phaseSine   = parseInt(document.getElementById('slPhaseSine').value, 10);
  p.phaseSquare = parseInt(document.getElementById('slPhaseSquare').value, 10);
  p.phaseSaw    = parseInt(document.getElementById('slPhaseSaw').value, 10);
  p.phaseTri    = parseInt(document.getElementById('slPhaseTri').value, 10);

  // Update the small numeric displays next to each slider.
  updateAllDisplays();

  // Redraw the waveform preview canvas to reflect the new settings.
  drawWave();
}

/**
 * updateAllDisplays() refreshes the <span class="val-display"> elements beside
 * each slider to show the current numeric value. Phase sliders show degrees.
 */
function updateAllDisplays() {
  const p = tParams[selTrack];

  // Map of slider IDs to their formatted display values.
  const map = {
    slSine:        p.sine.toFixed(2),
    slSquare:      p.square.toFixed(2),
    slSaw:         p.saw.toFixed(2),
    slTri:         p.tri.toFixed(2),
    slNoise:       p.noise.toFixed(2),
    slAttack:      p.attack.toFixed(3),
    slDecay:       p.decay.toFixed(2),
    slSustain:     p.sustain.toFixed(2),
    slRelease:     p.release.toFixed(2),
    slPhaseSine:   p.phaseSine + '°',
    slPhaseSquare: p.phaseSquare + '°',
    slPhaseSaw:    p.phaseSaw + '°',
    slPhaseTri:    p.phaseTri + '°'
  };

  // For each entry, find the <span> with the matching data-for attribute and
  // set its text content.
  for (const [id, text] of Object.entries(map)) {
    const span = document.querySelector(`.val-display[data-for="${id}"]`);
    if (span) span.textContent = text;
  }
}

// ── Wire up all slider 'input' events to saveSliders() ──
// Every time a user drags any of these sliders, we save the values.
[
  'slSine', 'slSquare', 'slSaw', 'slTri', 'slNoise',
  'slAttack', 'slDecay', 'slSustain', 'slRelease',
  'slFreq', 'slPhaseSine', 'slPhaseSquare', 'slPhaseSaw', 'slPhaseTri'
].forEach(id => {
  const el = document.getElementById(id);

  // 'input' fires continuously while dragging; 'change' only fires on release.
  // We use 'input' for real-time feedback.
  el.addEventListener('input', saveSliders);

  // ── BUG FIX #3: Spacebar preview after slider interaction ──
  // Problem: when a range slider has focus, pressing Spacebar moves the slider
  // thumb instead of triggering the preview sound. The old fix checked
  // e.target.tagName === 'INPUT' which blocked *all* inputs including ranges.
  //
  // Solution: blur the slider on mouseup so it loses focus. This way, the
  // keydown listener's Spacebar handler will fire normally.
  el.addEventListener('mouseup', () => el.blur());
  el.addEventListener('touchend', () => el.blur());
});

// ── Frequency text input: two-way sync with the frequency slider ──
// When the user types a number directly, we update the slider and the track
// parameter to match.
document.getElementById('inpHz').addEventListener('input', () => {
  // Clamp the typed value between 20 Hz and 20 kHz.
  const v = Math.max(20, Math.min(20000,
    parseFloat(document.getElementById('inpHz').value) || 20
  ));

  // Update the range slider to match the typed value.
  document.getElementById('slFreq').value = v;

  // Store the frequency in the track parameters.
  const p = tParams[selTrack];
  p.freq = v;

  // Propagate to non-edited steps.
  propagateBaseFreq(p);

  // Redraw the waveform canvas with the new frequency's phase-delay ratio.
  drawWave();
});

// ─── Preview ────────────────────────────────────────────────────────────────

/**
 * previewSound() triggers the currently-selected track's sound immediately.
 * This lets the user audition their mix without running the full sequencer.
 */
function previewSound() {
  // The AudioContext starts in a "suspended" state on many browsers until a
  // user gesture occurs. We resume it here to ensure audio can play.
  if (ctx.state === 'suspended') ctx.resume();

  // Trigger the sound for the active track at the current audio time.
  triggerSound(selTrack, ctx.currentTime);
}

// Clicking the Preview button fires previewSound().
document.getElementById('btnPreview').addEventListener('click', previewSound);

// ── Keyboard shortcut: Spacebar triggers preview ──
document.addEventListener('keydown', e => {
  if (e.code === 'Space') {
    // Allow Spacebar if the focused element is NOT a text/number input or button.
    // Range sliders are OK because we blur them on mouseup (see bug fix above).
    // We also need to allow it when focus is on the <body> or any non-input.
    const tag = e.target.tagName;                 // e.g. 'INPUT', 'BUTTON', 'BODY'
    const inputType = e.target.type || '';        // e.g. 'range', 'number', 'text'

    // Block Spacebar only for text/number inputs and buttons (where Space has
    // a native meaning — typing a space character or clicking the button).
    if (tag === 'BUTTON') return;                              // let button clicks work normally
    if (tag === 'INPUT' && inputType !== 'range') return;      // let text inputs type spaces

    // Prevent the browser's default Spacebar behaviour (page scroll).
    e.preventDefault();

    // Fire the preview.
    previewSound();
  }
});

// ─── Audio Engine: Sound Triggering ─────────────────────────────────────────

/**
 * triggerSound(t, time) creates a short percussive note for track `t`,
 * scheduled to start at audioContext time `time`.
 *
 * Audio graph for each call:
 *
 *   OscillatorNode (sine)   ──► DelayNode ──► GainNode (vol) ──┐
 *   OscillatorNode (square) ──► DelayNode ──► GainNode (vol) ──┤
 *   OscillatorNode (saw)    ──► DelayNode ──► GainNode (vol) ──┼──► GainNode (master envelope)
 *   OscillatorNode (tri)    ──► DelayNode ──► GainNode (vol) ──┤         │
 *   BufferSourceNode (noise)───────────────► GainNode (vol) ──┘         │
 *                                                                       ▼
 *                                                              AnalyserNode (FFT)
 *                                                                       │
 *                                                                       ▼
 *                                                            AudioContext.destination
 *                                                                  (speakers)
 *
 * The DelayNode implements the phase shift: delay = (phaseDeg / 360) / freq.
 * This shifts the oscillator's output in time by an amount equal to the
 * desired fraction of one period.
 *
 * @param {number} t    - Track index (0–4).
 * @param {number} time - audioContext.currentTime at which to start the note.
 * @param {number} step - The index of the step being triggered (optional, used for per-step pitch).
 */
function triggerSound(t, time, step) {
  // Retrieve this track's parameter object.
  const p = tParams[t];

  // ── Determine Base Frequency ──
  // If Per-Step Pitch is enabled and a valid step was provided, use that step's specific frequency.
  // Otherwise, fallback to the track's default frequency.
  const baseFreq = (p.perStepPitch && step !== undefined) 
    ? (p.stepFreqs[step] || p.freq) 
    : p.freq;

  // ── ADSR Envelope Timing ──
  const atk  = p.attack;              // attack time in seconds
  const dec  = p.decay;               // decay time in seconds
  const sus  = p.sustain;             // sustain level (fraction of peak, 0–1)
  const rel  = p.release;             // release time in seconds
  const gate = 0.075;                 // sustain hold ("gate") duration: 75 ms
  const dur  = atk + dec + gate + rel + 0.05; // total note duration (with safety margin)

  // Compute the sustain gain level. Use Math.max to keep above 0.001
  // because exponentialRamp cannot target 0.
  const sustainLevel = Math.max(p.vol * sus, 0.001);

  // ── Master Gain (ADSR volume envelope) ──
  // This GainNode shapes the amplitude over time through four phases:
  //   1. Attack:  silence → peak volume
  //   2. Decay:   peak volume → sustain level
  //   3. Sustain: hold at sustain level for 'gate' duration
  //   4. Release: sustain level → near-silence (0.001)
  const master = ctx.createGain();

  // Phase 1: Attack — start at silence, ramp to peak.
  master.gain.setValueAtTime(0, time);
  master.gain.linearRampToValueAtTime(p.vol, time + atk);

  // Phase 2: Decay — ramp from peak down to the sustain level.
  master.gain.linearRampToValueAtTime(sustainLevel, time + atk + dec);

  // Phase 3: Sustain — hold the sustain level for the gate duration.
  master.gain.setValueAtTime(sustainLevel, time + atk + dec + gate);

  // Phase 4: Release — fade from sustain level to near-silence.
  master.gain.exponentialRampToValueAtTime(0.001, time + atk + dec + gate + rel);

  // Route the master gain through the shared analyser node, which is already
  // connected to ctx.destination. This means every sound is both analysed
  // (for the spectrometer) and heard.
  master.connect(analyser);

  // ── Glissando Target Frequency (cents-based, release-only) ──
  // Pre-compute the target frequency for the pitch bend so we can apply it
  // to all oscillators consistently.
  let glissTargetFreq = baseFreq;
  if (p.glissando) {
    // Apply direction: 'down' negates the cents value.
    const signedCents = p.glissDir === 'down' ? -Math.abs(p.glissCents) : Math.abs(p.glissCents);
    // Cents formula: targetFreq = baseFreq * 2^(cents/1200)
    glissTargetFreq = baseFreq * Math.pow(2, signedCents / 1200);
    // Ensure the target is at least 1 Hz (linearRamp can handle any positive value).
    glissTargetFreq = Math.max(glissTargetFreq, 1);
  }

  // ── Oscillator Waveforms ──
  // We iterate over the four standard oscillator types. For each one that has
  // a non-zero volume, we create an OscillatorNode, a DelayNode (for phase),
  // and a GainNode (for the individual waveform's volume).
  const waveforms = [
    ['sine',     p.sine,   p.phaseSine],    // [waveType, volume, phaseDegrees]
    ['square',   p.square, p.phaseSquare],
    ['sawtooth', p.saw,    p.phaseSaw],
    ['triangle', p.tri,    p.phaseTri]
  ];

  waveforms.forEach(([type, vol, phaseDeg]) => {
    // Skip this waveform if its volume is zero — no point creating nodes.
    if (vol <= 0) return;

    // Create an OscillatorNode. This generates a periodic waveform at the
    // specified frequency. The Web Audio API supports four built-in types:
    // 'sine', 'square', 'sawtooth', and 'triangle'.
    const osc = ctx.createOscillator();
    osc.type = type;                 // set the waveform shape
    
    // Set initial frequency — stays steady through Attack, Decay, and Sustain.
    osc.frequency.setValueAtTime(baseFreq, time);
    
    // ── Glissando (Pitch Bend during Release only) ──
    if (p.glissando) {
      // Hold the base frequency steady through the end of the sustain gate.
      osc.frequency.setValueAtTime(baseFreq, time + atk + dec + gate);
      // Bend to the target frequency linearly over the release duration.
      osc.frequency.linearRampToValueAtTime(glissTargetFreq, time + atk + dec + gate + rel);
    }

    // ── Phase Shift via DelayNode ──
    // The standard OscillatorNode has no phase parameter. To achieve a phase
    // offset, we delay the oscillator's output by a fraction of its period.
    //
    // The math:
    //   One full period of a wave at frequency f is  T = 1/f  seconds.
    //   A phase offset of φ degrees is  (φ/360) of one period.
    //   Therefore:  delay = (φ / 360) / f  seconds.
    //
    // Example: 90° phase shift at 440 Hz →  delay = (90/360) / 440 ≈ 0.000568 s
    //
    // We use ctx.createDelay(1) — the argument is the maximum delay in seconds.
    // 1 second is more than enough for any audible frequency.
    const delay = ctx.createDelay(1);
    delay.delayTime.value = (phaseDeg / 360) / baseFreq;

    // Create a GainNode to control this waveform's individual volume.
    const g = ctx.createGain();
    g.gain.value = vol;              // set to the waveform's volume slider value

    // Connect the nodes: oscillator → delay → gain → master envelope.
    osc.connect(delay);
    delay.connect(g);
    g.connect(master);

    // Schedule the oscillator to start and stop. Web Audio oscillators are
    // "use once" — each OscillatorNode can only be started and stopped once.
    // After stopping, the node is automatically garbage-collected.
    osc.start(time);
    osc.stop(time + dur);
  });

  // ── White Noise ──
  // Noise doesn't have a phase concept (it's random), so no DelayNode is used.
  // Pitch (frequency) does not affect white noise.
  if (p.noise > 0) {
    // Calculate how many audio samples we need for the note's duration.
    const bufLen = Math.ceil(ctx.sampleRate * dur);

    // Create an AudioBuffer: a chunk of raw audio data in memory.
    // Arguments: numberOfChannels, length (in samples), sampleRate.
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);

    // Get a reference to the buffer's Float32Array of sample values.
    const data = buf.getChannelData(0);

    // Fill the buffer with random values between −1 and +1 — this is white
    // noise: every sample is independently and uniformly distributed.
    for (let i = 0; i < bufLen; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    // A BufferSourceNode plays back an AudioBuffer. Like OscillatorNodes,
    // these are single-use: one start/stop per node.
    const src = ctx.createBufferSource();
    src.buffer = buf;

    // Volume control for the noise.
    const g = ctx.createGain();
    g.gain.value = p.noise;

    // Connect: buffer source → gain → master envelope.
    src.connect(g);
    g.connect(master);

    // Schedule playback.
    src.start(time);
    src.stop(time + dur);
  }
}

// ─── Lookahead Scheduler ────────────────────────────────────────────────────

// LOOKAHEAD: how far ahead (in seconds) the scheduler looks into the future.
// The scheduler will pre-schedule any steps that fall within the next 100 ms.
const LOOKAHEAD = 0.1;

// SCHED_INT: how often (in milliseconds) the scheduler callback runs.
// 25 ms is a good balance between CPU usage and timing accuracy.
// The JS timer (setInterval) is imprecise — it may jitter by several ms —
// but that's fine because the actual audio events are scheduled against
// audioContext.currentTime, which is sample-accurate.
const SCHED_INT = 25;

/**
 * scheduler() is called every SCHED_INT milliseconds while the sequencer is
 * playing. It checks if any steps fall within the lookahead window and, if
 * so, schedules their sounds using triggerSound().
 *
 * This is the "lookahead scheduling" pattern recommended by Chris Wilson
 * (Google) for sample-accurate Web Audio timing:
 * 1. A JS timer (setInterval) fires frequently (~25 ms).
 * 2. Each time it fires, it checks: are there steps in the near future
 *    (within LOOKAHEAD seconds)?
 * 3. If yes, schedule them using Web Audio's precise timing (start(time)).
 * 4. Advance the step counter and nextStepTime.
 *
 * Why not just use setInterval alone?  Because JS timers are not accurate
 * enough for musical timing — they can jitter by 10+ ms. But
 * audioContext.currentTime is driven by the audio hardware clock and is
 * sample-accurate. By scheduling slightly ahead, we get both reliability
 * (the JS timer has time to catch up) and precision (audio events are
 * placed on the exact sample).
 */
function scheduler() {
  // Read the current BPM from the input. Default to 120 if invalid.
  const bpm = parseFloat(document.getElementById('inpBpm').value) || 120;

  // Calculate the duration of one step.
  // At 120 BPM, one beat = 60/120 = 0.5 s.
  // We subdivide each beat into 4 steps (16th notes), so one step = 0.5/4 = 0.125 s.
  const stepDur = 60 / bpm / 4;

  while (nextStepTime < ctx.currentTime + LOOKAHEAD) {
    // For each track, check if the current step is active (checkbox checked).
    for (let t = 0; t < numTracks; t++) {
      if (tGrid[t][curStep]) {
        // This track's step is active — trigger its sound at the scheduled time.
        triggerSound(t, nextStepTime, curStep);
      }
    }

    // Highlight the active step column in the grid (visual feedback).
    highlightStep(curStep);

    // Advance to the next step, wrapping around to 0 at the end of the pattern.
    curStep = (curStep + 1) % numSteps;

    // Move the scheduled time forward by one step duration.
    nextStepTime += stepDur;
  }
}

/**
 * highlightStep(step) adds a CSS class to the checkboxes in the given column
 * so the user can see which step is currently playing. The highlight is
 * removed from the previous column.
 */
function highlightStep(step) {
  // Remove the highlight from ALL checkboxes first.
  document.querySelectorAll('#grid .grid-row input[type="checkbox"].step-active')
    .forEach(el => el.classList.remove('step-active'));

  // Add the highlight to every checkbox in the current step column.
  // We iterate rows and find the .step-cell at child index (step + 1)
  // because the track controls div is at index 0.
  const rows = document.querySelectorAll('#grid .grid-row');
  rows.forEach(row => {
    // child[0] is track-controls
    // child[step + 1] is the step-cell
    const cell = row.children[step + 1];
    if (cell && cell.classList.contains('step-cell')) {
      const cb = cell.querySelector('input[type="checkbox"]');
      if (cb) cb.classList.add('step-active');
    }
  });
}

/**
 * startStop() toggles the sequencer between playing and stopped states.
 */
function startStop() {
  if (!playing) {
    if (ctx.state === 'suspended') ctx.resume();
    curStep = 0;
    nextStepTime = ctx.currentTime;
    schedHandle = setInterval(scheduler, SCHED_INT);
    playing = true;
    document.getElementById('btnPlay').textContent = '■ Stop';
  } else {
    clearInterval(schedHandle);
    document.querySelectorAll('#grid .grid-row input[type="checkbox"].step-active')
      .forEach(el => el.classList.remove('step-active'));
    playing = false;
    document.getElementById('btnPlay').textContent = '▶ Play';
  }
}

// ─── Wave Shape Visualizer ──────────────────────────────────────────────────

/**
 * waveSample(t, p) computes the combined waveform amplitude at normalised
 * time t ∈ [0, 1), given the track parameters p. This is used to draw the
 * waveform preview on the <canvas id="cvWave">.
 *
 * Each waveform is evaluated with its individual phase offset applied:
 *   t' = (t + phaseDeg/360) mod 1
 * This shifts the wave horizontally by the specified number of degrees.
 *
 * The result is normalised by the sum of all active volumes so the preview
 * always fills the canvas regardless of how many waveforms are active.
 *
 * @param {number} t - Normalised time in [0, 1), representing one full period.
 * @param {object} p - Track parameter object (sine, square, saw, tri, noise,
 *                      phaseSine, phaseSquare, phaseSaw, phaseTri).
 * @returns {number}  - Amplitude in approximately [−1, +1].
 */
function waveSample(t, p) {
  // Accumulator for the mixed waveform amplitude.
  let s = 0;

  // ── Sine wave ──
  // Formula: sin(2π · t')
  // A pure sinusoidal oscillation — the simplest periodic waveform.
  // Phase offset shifts t by phaseSine/360 of one period.
  if (p.sine > 0) {
    // Apply phase offset: shift t by the fraction phaseSine/360, wrap with modulo.
    const tp = (t + p.phaseSine / 360) % 1;

    // Evaluate the sine function. 2π·t' maps [0,1) to [0, 2π) radians.
    s += p.sine * Math.sin(2 * Math.PI * tp);
  }

  // ── Square wave ──
  // A square wave alternates between +1 and −1. Mathematically, it's the
  // sign of the sine function: +1 when sin(2π·t') ≥ 0, −1 otherwise.
  // This produces a waveform that is "high" for the first half of each period
  // and "low" for the second half (at 0° phase).
  if (p.square > 0) {
    // Apply phase offset.
    const tp = (t + p.phaseSquare / 360) % 1;

    // Sign of sine: positive half → +1, negative half → −1.
    s += p.square * (Math.sin(2 * Math.PI * tp) >= 0 ? 1 : -1);
  }

  // ── Sawtooth wave ──
  // A sawtooth wave ramps linearly from −1 to +1 over one period, then
  // jumps back to −1. Formula: 2·t' − 1, where t' ∈ [0, 1).
  // At t'=0 the value is −1; at t'=0.5 it's 0; just before t'=1 it's +1.
  if (p.saw > 0) {
    // Apply phase offset.
    const tp = (t + p.phaseSaw / 360) % 1;

    // Linear ramp from −1 to +1.
    s += p.saw * (2 * tp - 1);
  }

  // ── Triangle wave ──
  // A triangle wave rises linearly from 0 to +1, falls to −1, and rises
  // back to 0 over one period. It's a piecewise linear function:
  //   t' ∈ [0,    0.25): y =  4·t'          (rising from 0 to +1)
  //   t' ∈ [0.25, 0.75): y =  2 − 4·t'      (falling from +1 to −1)
  //   t' ∈ [0.75, 1   ): y =  4·t' − 4       (rising from −1 to 0)
  //
  // Why these formulas?
  //   • The period is normalised to [0,1). The triangle has 4 quarter-segments.
  //   • In the first quarter (0→0.25), we go from 0 to +1: slope = 1/0.25 = 4.
  //   • In the middle half (0.25→0.75), we go from +1 to −1: slope = −2/0.5 = −4.
  //     At t'=0.25: 2 − 4·0.25 = 1 ✓.  At t'=0.75: 2 − 4·0.75 = −1 ✓.
  //   • In the last quarter (0.75→1), we go from −1 to 0: slope = 1/0.25 = 4.
  //     At t'=0.75: 4·0.75 − 4 = −1 ✓.  At t'=1: 4·1 − 4 = 0 ✓.
  if (p.tri > 0) {
    // Apply phase offset.
    const tp = (t + p.phaseTri / 360) % 1;

    // Piecewise linear evaluation.
    const tv = tp < 0.25 ? 4 * tp
             : tp < 0.75 ? 2 - 4 * tp
             :             4 * tp - 4;

    s += p.tri * tv;
  }

  // ── White noise ──
  // Noise has no pitch or phase — it's just random sample values.
  // Math.random() returns [0, 1), so we map to [−1, +1) with: val*2 − 1.
  if (p.noise > 0) {
    s += p.noise * (Math.random() * 2 - 1);
  }

  // ── Normalisation ──
  // Sum the volumes of all active waveforms. We divide the mixed signal by
  // this total so the preview amplitude stays in roughly [−1, +1] regardless
  // of how many waveforms are layered. This prevents the canvas from clipping.
  const tot = p.sine + p.square + p.saw + p.tri + p.noise;

  // If no waveforms are active (tot === 0), return 0 to avoid division by zero.
  return tot > 0 ? s / tot : 0;
}

/**
 * drawWave() renders the waveform preview onto the <canvas id="cvWave">.
 * It samples waveSample() at every horizontal pixel, maps the result to a
 * vertical position, and draws a connected line (polyline).
 */
function drawWave() {
  // Get the canvas element and its 2D drawing context.
  const cvs = document.getElementById('cvWave');
  const c = cvs.getContext('2d');

  // Canvas dimensions in pixels.
  const W = cvs.width;
  const H = cvs.height;

  // The current track's parameters (for waveSample).
  const p = tParams[selTrack];

  // Vertical centre of the canvas — the zero-amplitude line.
  const mid = H / 2;

  // Padding in pixels so the waveform doesn't touch the very top/bottom.
  const pad = 4;

  // Clear the entire canvas (erase the previous frame).
  c.clearRect(0, 0, W, H);

  // ── Background ──
  c.fillStyle = '#0d0d1a';       // dark background matching the CSS card
  c.fillRect(0, 0, W, H);

  // ── Centre reference line (zero amplitude) ──
  c.beginPath();
  c.moveTo(0, mid);             // start at the left edge, vertically centred
  c.lineTo(W, mid);             // draw to the right edge
  c.strokeStyle = '#2a2a4a';    // subtle dark line
  c.lineWidth = 1;
  c.stroke();

  // ── Waveform polyline ──
  c.beginPath();

  // For each horizontal pixel, compute the waveform amplitude and convert it
  // to a vertical canvas coordinate.
  for (let x = 0; x < W; x++) {
    // Map the pixel x to a normalised time t ∈ [0, 1).
    // x=0 → t=0 (start of period); x=W-1 → t≈1 (end of period).
    const t = x / W;

    // Evaluate the mixed waveform at this time point.
    const amplitude = waveSample(t, p);

    // Convert amplitude (−1 to +1) to a canvas y coordinate.
    // amplitude = +1  →  y = mid − (mid−pad) = pad         (top of canvas)
    // amplitude =  0  →  y = mid                           (centre)
    // amplitude = −1  →  y = mid + (mid−pad) = H−pad       (bottom of canvas)
    const y = mid - amplitude * (mid - pad);

    // Start the path at the first pixel; draw lines for subsequent pixels.
    if (x === 0) c.moveTo(x, y);
    else         c.lineTo(x, y);
  }

  // Style the waveform line: bright accent colour, slightly thick.
  c.strokeStyle = '#e9a84c';
  c.lineWidth = 2;
  c.stroke();
}

// ─── Spectrometer (FFT Frequency Display) ───────────────────────────────────

// Create a typed array to hold the FFT frequency data. The analyser produces
// frequencyBinCount values (= fftSize / 2 = 2048 bins). Each value is a
// Uint8 (0–255) representing the magnitude of that frequency bin.
const freqBuf = new Uint8Array(analyser.frequencyBinCount);

/**
 * drawSpec() renders the real-time frequency spectrum onto <canvas id="cvSpec">.
 * It uses requestAnimationFrame for smooth ~60 fps updates.
 *
 * Two display modes are supported:
 *   • Linear: each FFT bin maps to an equal-width pixel column.
 *   • Logarithmic: the x-axis maps to frequency on a log scale (20 Hz – Nyquist).
 *     This is more perceptually useful because human hearing is roughly
 *     logarithmic — each octave (doubling of frequency) gets equal screen space.
 */
function drawSpec() {
  // Schedule the next frame. requestAnimationFrame calls drawSpec again
  // before the browser paints the next display frame (~16.7 ms at 60 Hz).
  requestAnimationFrame(drawSpec);

  // Get the canvas and its 2D context.
  const cvs = document.getElementById('cvSpec');
  const c = cvs.getContext('2d');

  // Canvas dimensions.
  const W = cvs.width;
  const H = cvs.height;

  // Check if the "Log" checkbox is ticked.
  const logMode = document.getElementById('chkLog').checked;

  // ── Fetch FFT data from the analyser ──
  // getByteFrequencyData fills our Uint8Array with the current magnitudes.
  // Each bin i represents the magnitude at frequency: i * (sampleRate / fftSize).
  analyser.getByteFrequencyData(freqBuf);

  // Total number of frequency bins.
  const bins = analyser.frequencyBinCount;  // = fftSize / 2 = 2048

  // The Nyquist frequency is half the sample rate — the highest frequency
  // that can be represented in digital audio. Typically 22050 Hz at 44.1 kHz.
  const nyquist = ctx.sampleRate / 2;

  // Clear the canvas.
  c.clearRect(0, 0, W, H);

  // Dark background.
  c.fillStyle = '#0d0d1a';
  c.fillRect(0, 0, W, H);

  if (logMode) {
    // ── Logarithmic frequency axis ──
    // We map pixel x to a frequency using an exponential curve:
    //   freq(x) = minF · e^(logR · x / W)
    //
    // Where:
    //   minF = 20 Hz (lower bound of human hearing)
    //   maxF = Nyquist frequency (~22050 Hz)
    //   logR = ln(maxF / minF) — the total "log range"
    //
    // This ensures that each octave occupies the same number of pixels:
    //   • 20–40 Hz (1 octave)  gets the same width as
    //   • 5000–10000 Hz (1 octave)
    //
    // At x=0:   freq = minF · e^0 = minF = 20 Hz          ✓
    // At x=W:   freq = minF · e^(logR) = minF · (maxF/minF) = maxF   ✓

    const minF = 20;                          // minimum displayed frequency (Hz)
    const maxF = nyquist;                     // maximum displayed frequency (Hz)
    const logR = Math.log(maxF / minF);       // natural log of the frequency ratio

    // For each pixel column, compute the corresponding frequency, look up the
    // FFT bin, and draw a bar.
    for (let x = 0; x < W; x++) {
      // Map pixel x to a frequency on the log scale.
      const freq = minF * Math.exp(logR * x / W);

      // Convert frequency to the nearest FFT bin index.
      // bin = round(freq / nyquist * bins)
      // This works because bin i corresponds to freq i * (sampleRate / fftSize)
      // = i * (nyquist * 2 / fftSize) = i * nyquist / bins.
      // So: freq = bin * nyquist / bins  →  bin = freq * bins / nyquist.
      const bin = Math.min(Math.round(freq / nyquist * bins), bins - 1);

      // Normalise the bin value from [0, 255] to [0, 1].
      const val = freqBuf[bin] / 255;

      // Compute the bar height in pixels.
      const barH = Math.ceil(val * (H - 2));

      // Colour: brighter teal-blue for louder frequencies.
      c.fillStyle = `rgb(0,${Math.round(val * 180)},${Math.round(val * 255)})`;

      // Draw a 1px-wide bar from the bottom of the canvas upwards.
      c.fillRect(x, H - 1 - barH, 1, barH);
    }
  } else {
    // ── Linear frequency axis ──
    // Each FFT bin gets an equal-width column. This is simpler but less
    // useful perceptually because most musical content is in the low bins,
    // which are cramped on the left.

    // Width of each bin's bar in pixels.
    const bw = W / bins;

    for (let i = 0; i < bins; i++) {
      // Normalise the bin magnitude to [0, 1].
      const val = freqBuf[i] / 255;

      // Bar height in pixels.
      const barH = Math.ceil(val * (H - 2));

      // Colour (same teal-blue gradient as log mode).
      c.fillStyle = `rgb(0,${Math.round(val * 180)},${Math.round(val * 255)})`;

      // Draw the bar. Math.max(1, bw - 0.5) ensures at least 1px width and
      // leaves a tiny gap between bars when there's room.
      c.fillRect(i * bw, H - 1 - barH, Math.max(1, bw - 0.5), barH);
    }
  }
}

// ─── Canvas Resizing ────────────────────────────────────────────────────────

/**
 * resizeCanvases() updates the canvas pixel dimensions to match their CSS
 * layout size. Canvas elements have two sizes:
 *   1. CSS size (how big they appear on screen) — set via CSS width: 100%.
 *   2. Pixel buffer size (their .width and .height properties) — determines
 *      the actual resolution of the drawing.
 *
 * If the pixel buffer is smaller than the CSS size, the canvas looks blurry.
 * We match them so the rendering is crisp.
 */
function resizeCanvases() {
  // ── Wave canvas ──
  const wave = document.getElementById('cvWave');

  // Read the CSS-computed width (how wide the canvas appears on screen).
  const waveDisplayWidth = wave.clientWidth || 300;

  // Set the pixel buffer to match. Height is half the width, capped at 200px.
  wave.width  = waveDisplayWidth;
  wave.height = Math.min(200, Math.round(waveDisplayWidth / 2));

  // ── Spectrometer canvas ──
  const spec = document.getElementById('cvSpec');
  const specDisplayWidth = spec.clientWidth || 300;

  // Set the pixel buffer width to the CSS width; keep height at 130px.
  spec.width  = specDisplayWidth;
  spec.height = 130;

  // Redraw the waveform canvas since we just cleared it by changing dimensions.
  drawWave();
}

// Re-measure canvases whenever the window is resized.
window.addEventListener('resize', resizeCanvases);

// ─── Event Listeners: Buttons & Controls ────────────────────────────────────

// Play/Stop button toggles the sequencer.
document.getElementById('btnPlay').addEventListener('click', startStop);

// Steps input: when the user changes the number of steps, rebuild the grid.
document.getElementById('inpSteps').addEventListener('change', rebuildGrid);

// The "Log" checkbox for the spectrometer doesn't need a handler — the
// drawSpec() animation loop reads chkLog.checked every frame automatically.
document.getElementById('chkLog').addEventListener('change', () => { });

// ─── Piano Note Selector Utility ────────────────────────────────────────────

/**
 * populates the given <select> element with all 88 piano keys (A0 through C8).
 */
function populateNoteDropdown(sel) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  for (let midi = 21; midi <= 108; midi++) {
    const name = names[midi % 12];
    const octave = Math.floor(midi / 12) - 1;
    const label = name + octave;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);

    const opt = document.createElement('option');
    opt.value = freq.toFixed(4);
    opt.textContent = label;
    sel.appendChild(opt);
  }
}

// Global Note Dropdown Initialization
(function initGlobalNoteSelector() {
  const sel = document.getElementById('selNote');
  populateNoteDropdown(sel);

  sel.addEventListener('change', () => {
    if (!sel.value) return;

    const f = parseFloat(sel.value);
    const p = tParams[selTrack];
    p.freq = f;
    document.getElementById('slFreq').value = f;
    document.getElementById('inpHz').value = Math.round(f * 100) / 100;

    // Propagate to non-edited steps.
    propagateBaseFreq(p);

    drawWave();
  });
})();

// ── Reset note selector when frequency is edited manually ──
// If the user drags the frequency slider or types in the Hz input, we clear
// the note dropdown because the frequency may no longer match any standard note.
function resetNoteSelector() {
  document.getElementById('selNote').value = '';
}

document.getElementById('slFreq').addEventListener('input', resetNoteSelector);
// document.getElementById('inpHz').addEventListener('change', resetNoteSelector); // Note: we handled this in the slider block

// ── Add Track button ──
document.getElementById('btnAddTrack').addEventListener('click', addTrack);

// ─── Per-Step Pitch Helpers ─────────────────────────────────────────────────

/**
 * propagateBaseFreq(p) updates all non-explicitly-edited steps to match
 * the track's current base frequency. Steps that the user has manually
 * edited via the per-step editor are left untouched.
 */
function propagateBaseFreq(p) {
  for (let i = 0; i < p.stepFreqs.length; i++) {
    if (!p.stepEdited[i]) {
      p.stepFreqs[i] = p.freq;
    }
  }
}

/**
 * selectStepForEditing(t, s) sets the given step as the active target for
 * the per-step pitch editor panel. Updates the UI highlight and populates
 * the editor inputs with the step's current frequency.
 */
function selectStepForEditing(t, s) {
  // Remove previous selection highlight.
  document.querySelectorAll('.step-selected').forEach(el => el.classList.remove('step-selected'));

  // Set the new selection.
  selectedStep = { track: t, step: s };

  // Highlight the selected checkbox.
  const cb = document.getElementById('cb' + t + '_' + s);
  if (cb) cb.classList.add('step-selected');

  // Show and populate the editor panel.
  const editor = document.getElementById('perStepEditor');
  editor.classList.add('active');

  document.getElementById('lblSelectedStep').textContent =
    'T' + (t + 1) + ' · Step ' + (s + 1);

  const currentFreq = tParams[t].stepFreqs[s];
  document.getElementById('inpStepHz').value = Math.round(currentFreq);

  // Sync the note dropdown to the current step frequency.
  const selNote = document.getElementById('selStepNote');
  syncDropdownToFreq(selNote, currentFreq);
}

/**
 * deselectStep() clears the per-step selection and hides the editor panel.
 */
function deselectStep() {
  selectedStep = null;
  document.querySelectorAll('.step-selected').forEach(el => el.classList.remove('step-selected'));
  document.getElementById('perStepEditor').classList.remove('active');
}

/**
 * syncDropdownToFreq(sel, freq) finds the closest matching note in the
 * dropdown and selects it if within 0.5 Hz.
 */
function syncDropdownToFreq(sel, freq) {
  let bestOpt = '';
  let bestDiff = Infinity;
  for (const opt of sel.options) {
    if (!opt.value) continue;
    const diff = Math.abs(parseFloat(opt.value) - freq);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestOpt = opt.value;
    }
  }
  sel.value = bestDiff < 0.5 ? bestOpt : '';
}

// ── Per-Step Editor: populate the step note dropdown ──
populateNoteDropdown(document.getElementById('selStepNote'));

// ── Per-Step Editor: Hz input handler ──
document.getElementById('inpStepHz').addEventListener('change', e => {
  if (!selectedStep) return;
  let val = parseFloat(e.target.value);
  if (isNaN(val) || val < 20) val = 20;
  if (val > 20000) val = 20000;
  e.target.value = val;

  const { track, step } = selectedStep;
  tParams[track].stepFreqs[step] = val;
  tParams[track].stepEdited[step] = true;

  // Clear the note dropdown since the user typed a custom value.
  document.getElementById('selStepNote').value = '';
});

// ── Per-Step Editor: Note dropdown handler ──
document.getElementById('selStepNote').addEventListener('change', e => {
  if (!selectedStep || !e.target.value) return;
  const val = parseFloat(e.target.value);

  const { track, step } = selectedStep;
  tParams[track].stepFreqs[step] = val;
  tParams[track].stepEdited[step] = true;

  document.getElementById('inpStepHz').value = Math.round(val);
});

// ── Per-Step Editor: Reset All Steps button ──
document.getElementById('btnResetSteps').addEventListener('click', () => {
  const p = tParams[selTrack];
  for (let i = 0; i < p.stepFreqs.length; i++) {
    p.stepFreqs[i] = p.freq;
    p.stepEdited[i] = false;
  }
  deselectStep();
});

// ── Per-Step Pitch toggle ──
document.getElementById('chkPerStep').addEventListener('change', e => {
  tParams[selTrack].perStepPitch = e.target.checked;
  if (!e.target.checked) {
    deselectStep();
  }
});

// ─── Glissando Controls ─────────────────────────────────────────────────────

// ── Glissando toggle checkbox ──
document.getElementById('chkGliss').addEventListener('change', e => {
  tParams[selTrack].glissando = e.target.checked;
  document.getElementById('inpGliss').disabled = !e.target.checked;
  document.getElementById('selGlissDir').disabled = !e.target.checked;
});

// ── Glissando cents input ──
document.getElementById('inpGliss').addEventListener('change', e => {
  let val = parseInt(e.target.value, 10);
  if (isNaN(val)) val = 0;
  val = Math.max(-2400, Math.min(2400, val));
  e.target.value = val;
  tParams[selTrack].glissCents = val;
});

// ── Glissando direction dropdown ──
document.getElementById('selGlissDir').addEventListener('change', e => {
  tParams[selTrack].glissDir = e.target.value;
});

// ─── Initialisation ─────────────────────────────────────────────────────────

// Build the step grid with the default 16 steps.
rebuildGrid();

// Load the first track's parameters into the slider panel.
loadSliders();

// Size the canvases to fit the current window width.
resizeCanvases();

// Start the spectrometer animation loop (runs continuously via rAF).
drawSpec();
