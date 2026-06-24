// ============================================================================
// THREE.JS AUDIO-REACTIVE VISUALIZER — "TouchDesigner" Feedback Aesthetic
// ============================================================================
//
// Architecture overview:
//
//   ┌─────────────┐   current    ┌──────────────────┐   blended    ┌────────┐
//   │  Main Scene  │──────────►  │  Feedback Shader  │───────────►  │ Screen │
//   │ (4 shapes)   │  sceneRT    │  prev*0.985       │  readFB      │ (tone  │
//   └─────────────┘              │  +curr, clamp≤1   │              │  map + │
//         ▲                      └──────┬───────────┘              │ vignet)│
//         │                             │ ping-pong                └────────┘
//         │  audio data                 ▼
//   ┌─────┴──────┐              ┌──────────────────┐
//   │ AnalyserNode│              │   writeFB (swap)  │
//   │ (sequencer) │              └──────────────────┘
//   └────────────┘
//
// Key behaviours:
//   • "Scrolling spectrum": only the CURRENT audio frame is drawn as fresh
//     geometry each tick. The feedback loop preserves and expands all
//     previous frames outward, creating streaming tails.
//   • Zero audio = zero visibility: vertex colors are scaled by intensity,
//     so silence produces black geometry on a black background = nothing.
//   • No whiteout: feedback shader clamps RGB ≤ 1.0 after additive blend.
//   • Organic drift: all projections continuously rotate and oscillate,
//     feeding spiraling motion into the feedback loop.
//
// Dependencies (from sequencer.js globals):
//   • ctx       — the AudioContext
//   • analyser  — the AnalyserNode connected to ctx.destination
// ============================================================================

(function () {
  'use strict';

  // ─── Guard ────────────────────────────────────────────────────────────────

  if (typeof ctx === 'undefined' || typeof analyser === 'undefined') {
    console.error('[Visualizer] sequencer.js globals (ctx, analyser) not found.');
    return;
  }

  // ─── Configuration ────────────────────────────────────────────────────────

  const NUM_POINTS    = 256;   // Visual data points sampled from the FFT
  const ATTACK_RATE   = 0.35;  // ADSR attack: fast snap to peaks
  const RELEASE_RATE  = 0.04;  // ADSR release: slow decay (buttery smooth)
  const BASE_SCALE    = 3.8;   // Overall projection size multiplier

  // Feedback shader constants (embedded in GLSL, mirrored here for docs).
  // UV_SCALE  = 0.98  → 2% outward expansion per frame
  // RGB_DECAY = 0.985 → slow fade; ~40% brightness after 1 second

  // ─── Container & Renderer ─────────────────────────────────────────────────

  const container = document.getElementById('visualizer-container');
  if (!container) {
    console.error('[Visualizer] #visualizer-container not found in DOM.');
    return;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.autoClear = false; // We drive clears manually per pass
  container.appendChild(renderer.domElement);

  // ─── Main Scene ───────────────────────────────────────────────────────────
  // Background is STRICTLY black so that silent geometry (black vertex colors)
  // contributes nothing to the feedback accumulation.

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const frustumSize = 10;
  let aspect = container.clientWidth / container.clientHeight || 16 / 9;
  const camera = new THREE.OrthographicCamera(
    -frustumSize * aspect / 2, frustumSize * aspect / 2,
    frustumSize / 2, -frustumSize / 2,
    0.1, 100
  );
  camera.position.z = 10;

  // ─── Fullscreen Quad Infrastructure ────────────────────────────────────────
  // Shared by both post-processing passes (feedback + display).

  const quadCamera   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeometry = new THREE.PlaneGeometry(2, 2);

  // ─── Render Targets (Ping-Pong FBOs) ──────────────────────────────────────
  //
  // Three render targets:
  //   sceneRT  — receives the fresh geometry render each frame
  //   readFB   — previous frame's accumulated feedback (read only)
  //   writeFB  — new blended result (write only), then swapped with readFB

  let width  = container.clientWidth;
  let height = container.clientHeight;

  function createRT(w, h) {
    const pr = renderer.getPixelRatio();
    return new THREE.WebGLRenderTarget(
      Math.floor(w * pr),
      Math.floor(h * pr),
      {
        minFilter:     THREE.LinearFilter,
        magFilter:     THREE.LinearFilter,
        format:        THREE.RGBAFormat,
        depthBuffer:   false,
        stencilBuffer: false
      }
    );
  }

  let sceneRT      = createRT(width, height);
  let feedbackRT_A = createRT(width, height);
  let feedbackRT_B = createRT(width, height);
  let readFB  = feedbackRT_A;
  let writeFB = feedbackRT_B;

  // ─── Feedback Shader ──────────────────────────────────────────────────────
  //
  // The core of the "visual reverb." Every frame this shader:
  //
  //   1. Samples the PREVIOUS accumulated frame at UVs scaled 2% outward
  //      from center → content expands endlessly toward viewport edges.
  //   2. Applies a 5-tap cross blur (diffuses trails for smooth glow).
  //   3. Multiplies by 0.985 decay → trails slowly fade to black.
  //   4. Adds the CURRENT frame's fresh geometry.
  //   5. Clamps result to ≤ 1.0 → prevents additive whiteout.

  const feedbackMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tPrevFrame:    { value: null },
      tCurrentFrame: { value: null },
      uResolution:   { value: new THREE.Vector2(1, 1) }
    },
    vertexShader: [
      'varying vec2 vUv;',
      'void main() {',
      '  vUv = uv;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D tPrevFrame;',
      'uniform sampler2D tCurrentFrame;',
      'uniform vec2 uResolution;',
      'varying vec2 vUv;',
      '',
      'void main() {',
      '  // ── Outward UV expansion ──',
      '  // Shrink sample coordinates toward center by 2%.',
      '  // This makes the CONTENT appear to zoom outward each frame,',
      '  // creating the endlessly expanding tail effect.',
      '  vec2 centeredUV = vUv - 0.5;',
      '  vec2 scaledUV   = centeredUV * 0.98 + 0.5;',
      '',
      '  // ── 5-tap cross blur on previous frame ──',
      '  // Softens trail edges for a smooth, diffused glow.',
      '  vec2 texel = 1.0 / uResolution;',
      '  vec3 prev = texture2D(tPrevFrame, scaledUV).rgb                          * 0.4',
      '            + texture2D(tPrevFrame, scaledUV + vec2( texel.x, 0.0)).rgb    * 0.15',
      '            + texture2D(tPrevFrame, scaledUV + vec2(-texel.x, 0.0)).rgb    * 0.15',
      '            + texture2D(tPrevFrame, scaledUV + vec2(0.0,  texel.y)).rgb    * 0.15',
      '            + texture2D(tPrevFrame, scaledUV + vec2(0.0, -texel.y)).rgb    * 0.15;',
      '',
      '  // ── Decay: slow fade to black ──',
      '  // 0.985 per frame ≈ 40% brightness after 1 second at 60 fps.',
      '  prev *= 0.985;',
      '',
      '  // ── Blend: previous trails + fresh current frame ──',
      '  vec3 curr = texture2D(tCurrentFrame, vUv).rgb;',
      '',
      '  // ── Clamp: prevent additive blowout to white ──',
      '  vec3 result = min(prev + curr, vec3(1.0));',
      '',
      '  gl_FragColor = vec4(result, 1.0);',
      '}'
    ].join('\n'),
    depthTest:  false,
    depthWrite: false
  });

  const feedbackQuad  = new THREE.Mesh(quadGeometry, feedbackMaterial);
  const feedbackScene = new THREE.Scene();
  feedbackScene.add(feedbackQuad);

  // ─── Display Shader (Final Output) ────────────────────────────────────────
  // Takes the clamped [0,1] feedback texture and applies:
  //   • Subtle gamma boost for richer color vibrancy
  //   • Cinematic vignette (darkened edges)

  const displayMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tTexture: { value: null },
      uAudioBands: { value: new THREE.Vector3(0, 0, 0) }
    },
    vertexShader: [
      'varying vec2 vUv;',
      'void main() {',
      '  vUv = uv;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D tTexture;',
      'uniform vec3 uAudioBands;',
      'varying vec2 vUv;',
      '',
      'void main() {',
      '  vec3 color = texture2D(tTexture, vUv).rgb;',
      '',
      '  // Slight gamma lift for vibrancy',
      '  color = pow(color, vec3(0.92));',
      '',
      '  // Cinematic vignette — darkens edges for depth',
      '  float vig = 1.0 - length((vUv - 0.5) * 1.4);',
      '  vig = smoothstep(0.0, 1.0, vig);',
      '',
      '  // Audio-reactive edge halo (Low=Red, Mid=Green, High=Blue)',
      '  float edge = 1.0 - vig;',
      '  vec3 haloColor = vec3(uAudioBands.x * 0.8, uAudioBands.y * 0.6, uAudioBands.z * 1.2);',
      '  haloColor *= edge * 1.5;',
      '',
      '  color *= mix(0.15, 1.0, vig);',
      '  color += haloColor; // additive blend',
      '',
      '  gl_FragColor = vec4(color, 1.0);',
      '}'
    ].join('\n'),
    depthTest:  false,
    depthWrite: false
  });

  const displayQuad  = new THREE.Mesh(quadGeometry, displayMaterial);
  const displayScene = new THREE.Scene();
  displayScene.add(displayQuad);

  // ─── Audio Data & Logarithmic Mapping ─────────────────────────────────────

  const rawFreqData  = new Uint8Array(analyser.frequencyBinCount);
  const smoothedData = new Float32Array(NUM_POINTS);
  
  // Sub-stepping data structures
  const SUB_STEPS = 4;
  const prevSmoothedData = new Float32Array(NUM_POINTS);
  const stepSmoothedData = new Float32Array(NUM_POINTS);

  // Pre-computed log-scale bin map: visual point index → FFT bin.
  // Logarithmic distribution gives bass/kicks proportionally more visual
  // real estate, matching human perception and filling shapes uniformly.
  const logBinMap = new Uint32Array(NUM_POINTS);

  function computeLogBinMap() {
    const binCount = analyser.frequencyBinCount;
    const nyquist  = ctx.sampleRate / 2;
    const logMin   = Math.log(20);
    const logMax   = Math.log(nyquist);

    for (let i = 0; i < NUM_POINTS; i++) {
      const t    = i / (NUM_POINTS - 1);
      const freq = Math.exp(logMin + t * (logMax - logMin));
      logBinMap[i] = Math.min(Math.round((freq / nyquist) * binCount), binCount - 1);
    }
  }
  computeLogBinMap();

  /**
   * updateAudioData() — fetches the FFT, applies logarithmic resampling
   * with a ±3 bin anti-aliasing window, then ADSR-style envelope smoothing.
   *
   * The ADSR envelope ensures:
   *   • Attack: instant visual snap to audio peaks (rate 0.35)
   *   • Release: slow graceful decay when audio drops (rate 0.04)
   * This makes the injection into the feedback loop buttery smooth.
   */
  function updateAudioData() {
    analyser.getByteFrequencyData(rawFreqData);
    const binCount = analyser.frequencyBinCount;

    for (let i = 0; i < NUM_POINTS; i++) {
      const bin = logBinMap[i];

      // Anti-aliased sampling: average ±3 bins around the log-mapped target
      let sum   = 0;
      let count = 0;
      const lo  = Math.max(0, bin - 3);
      const hi  = Math.min(binCount - 1, bin + 3);
      for (let b = lo; b <= hi; b++) {
        sum += rawFreqData[b];
        count++;
      }
      const rawVal = (sum / count) / 255;

      // ADSR envelope
      if (rawVal > smoothedData[i]) {
        smoothedData[i] += (rawVal - smoothedData[i]) * ATTACK_RATE;
      } else {
        smoothedData[i] += (rawVal - smoothedData[i]) * RELEASE_RATE;
      }
    }
  }

  // ─── Color Palette System ─────────────────────────────────────────────────

  function lerpColor(a, b, t) {
    return new THREE.Color(
      a.r + (b.r - a.r) * t,
      a.g + (b.g - a.g) * t,
      a.b + (b.b - a.b) * t
    );
  }

  const palettes = {
    circle:   { low: new THREE.Color(0x7ec8e3), high: new THREE.Color(0xff69b4) },  // Light Blue → Pink
    line:     { low: new THREE.Color(0x4caf50), high: new THREE.Color(0xff9800) },  // Green → Orange
    fishEye:  { low: new THREE.Color(0xffb6c1), high: new THREE.Color(0x40e0d0) },  // Light Pink → Turquoise
    curveMap: { low: new THREE.Color(0xffcc80), high: new THREE.Color(0x00e5ff) }   // Light Orange → Cyan
  };

  // ─── Projection Builders ──────────────────────────────────────────────────

  /**
   * createLineProj(n) — builds a THREE.Line with per-vertex position & color
   * buffers. Uses additive blending so overlapping projections create
   * glowing interference.
   */
  function createLineProj(n) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));

    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      blending:     THREE.AdditiveBlending,
      transparent:  true,
      opacity:      1.0,
      depthTest:    false
    });

    return { obj: new THREE.Line(geo, mat), pos, col };
  }

  /**
   * createPointsProj(n, size) — builds a THREE.Points cloud that overlays
   * its paired line, adding visual mass that feeds heavily into the feedback
   * loop for denser, thicker glow.
   */
  function createPointsProj(n, size) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));

    const mat = new THREE.PointsMaterial({
      size:            size,
      vertexColors:    true,
      blending:        THREE.AdditiveBlending,
      transparent:     true,
      opacity:         0.9,
      depthTest:       false,
      sizeAttenuation: true
    });

    return { obj: new THREE.Points(geo, mat), pos, col };
  }

  // ─── Instantiate Projections ──────────────────────────────────────────────

  // 1. Circle — radial spectrum mapping
  const circLine = createLineProj(NUM_POINTS + 1);   // +1 to close the ring
  const circPts  = createPointsProj(NUM_POINTS + 1, 0.18);
  scene.add(circLine.obj);
  scene.add(circPts.obj);

  // 2. Line — horizontal amplitude graph
  const lineLine = createLineProj(NUM_POINTS + 1);
  const linePts  = createPointsProj(NUM_POINTS + 1, 0.14);
  scene.add(lineLine.obj);
  scene.add(linePts.obj);

  // 3. Fish-Eye — spherical bulge distortion
  const fishLine = createLineProj(NUM_POINTS + 1);
  const fishPts  = createPointsProj(NUM_POINTS + 1, 0.16);
  scene.add(fishLine.obj);
  scene.add(fishPts.obj);

  // 4. Curve Map — sine-wave baseline
  const curvLine = createLineProj(NUM_POINTS + 1);
  const curvPts  = createPointsProj(NUM_POINTS + 1, 0.14);
  scene.add(curvLine.obj);
  scene.add(curvPts.obj);

  // ─── Morphing & Projection State ──────────────────────────────────────────
  
  // Pure math functions for each shape, taking index, intensity, and returning position.
  const shapeMath = {
    circle: (i, intensity, outPos) => {
      const angle = (i / NUM_POINTS) * Math.PI * 2;
      const r = BASE_SCALE * 0.45 + intensity * BASE_SCALE * 0.5;
      outPos.x = Math.cos(angle) * r;
      outPos.y = Math.sin(angle) * r;
      outPos.z = 0;
    },
    line: (i, intensity, outPos) => {
      const t = i / NUM_POINTS;
      const w = BASE_SCALE * 1.6;
      outPos.x = (t - 0.5) * w;
      outPos.y = intensity * BASE_SCALE * 0.55;
      outPos.z = 0;
    },
    fishEye: (i, intensity, outPos) => {
      const t = i / NUM_POINTS;
      const angle = (t - 0.5) * Math.PI * 2;
      const bulge = Math.sin(t * Math.PI);
      const radius = BASE_SCALE * 0.5;
      const distortion = 1.0 + intensity * 1.6;
      outPos.x = Math.sin(angle) * radius * distortion;
      outPos.y = bulge * radius * distortion * 0.8 + intensity * BASE_SCALE * 0.18;
      outPos.z = 0;
    },
    curveMap: (i, intensity, outPos) => {
      const t = i / NUM_POINTS;
      const w = BASE_SCALE * 1.4;
      const sineBase = Math.sin(t * Math.PI * 4) * BASE_SCALE * 0.25;
      outPos.x = (t - 0.5) * w;
      outPos.y = sineBase + intensity * BASE_SCALE * 0.5;
      outPos.z = 0;
    }
  };

  const shapeNames = ['circle', 'line', 'fishEye', 'curveMap'];

  // Base offset origins for each projection (the "home" position).
  const DRIFT = {
    circle:   { x: -1.3, y:  1.2 },
    line:     { x:  1.0, y: -1.4 },
    fishEye:  { x:  1.5, y:  1.0 },
    curveMap: { x: -1.5, y: -1.5 }
  };

  const projections = [
    { id: 'circle',   line: circLine, pts: circPts, pal: palettes.circle,   shape: 'circle',   targetShape: 'circle',   morphProgress: 0, cooldown: 0, rotVel:  0.005, targetRotVel:  0.005, rot: 0, posOffset: DRIFT.circle },
    { id: 'line',     line: lineLine, pts: linePts, pal: palettes.line,     shape: 'line',     targetShape: 'line',     morphProgress: 0, cooldown: 0, rotVel: -0.003, targetRotVel: -0.003, rot: 0, posOffset: DRIFT.line },
    { id: 'fishEye',  line: fishLine, pts: fishPts, pal: palettes.fishEye,  shape: 'fishEye',  targetShape: 'fishEye',  morphProgress: 0, cooldown: 0, rotVel:  0.007, targetRotVel:  0.007, rot: 0, posOffset: DRIFT.fishEye },
    { id: 'curveMap', line: curvLine, pts: curvPts, pal: palettes.curveMap, shape: 'curveMap', targetShape: 'curveMap', morphProgress: 0, cooldown: 0, rotVel: -0.004, targetRotVel: -0.004, rot: 0, posOffset: DRIFT.curveMap }
  ];

  function easeInOutCubic(x) {
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }

  // Temp vectors for interpolation
  const posA = new THREE.Vector3();
  const posB = new THREE.Vector3();
  const tempHSL = {};

  // Track the passage of time for random events
  let lastMorphRollTime = 0;
  let lastRotRollTime   = 0;

  function updateProjections(currentData, intensityDivisor = 1) {
    const now = performance.now();
    const dt = 16.666; // Assume ~60fps for simple state timers

    // ── 5s Morph Roll ──
    if (now - lastMorphRollTime > 5000) {
      lastMorphRollTime = now;
      // Find eligible projections (not morphing, cooldown <= 0)
      const eligible = projections.filter(p => p.shape === p.targetShape && p.cooldown <= 0);
      if (eligible.length > 0) {
        // 30% chance to morph
        if (Math.random() < 0.3) {
          const p = eligible[Math.floor(Math.random() * eligible.length)];
          const newTarget = shapeNames[Math.floor(Math.random() * shapeNames.length)];
          if (newTarget !== p.shape) {
            p.targetShape = newTarget;
            p.morphProgress = 0;
          }
        }
      }
    }

    // ── Update and Render Each Projection ──
    projections.forEach(p => {
      // Manage Cooldowns & Morph Progress
      if (p.cooldown > 0) p.cooldown -= dt;

      let easedProgress = 0;
      if (p.shape !== p.targetShape) {
        // Morph over 25 seconds
        p.morphProgress += dt / 25000;
        if (p.morphProgress >= 1) {
          p.shape = p.targetShape;
          p.morphProgress = 0;
          p.cooldown = 15000; // 15s cooldown
        }
        easedProgress = easeInOutCubic(Math.min(1, p.morphProgress));
      }

      // Fill buffers
      for (let i = 0; i <= NUM_POINTS; i++) {
        const idx = i % NUM_POINTS;
        const intensity = currentData[idx];

        // Position interpolation
        shapeMath[p.shape](i, intensity, posA);
        if (p.shape !== p.targetShape) {
          shapeMath[p.targetShape](i, intensity, posB);
          posA.lerp(posB, easedProgress);
        }

        p.line.pos[i * 3]     = posA.x;
        p.line.pos[i * 3 + 1] = posA.y;
        p.line.pos[i * 3 + 2] = posA.z;

        // Color logic (with intensityDivisor for sub-stepping)
        // Lerp between palette low/high
        const c = lerpColor(p.pal.low, p.pal.high, intensity);
        
        // Chromatic inversion: shift hue per-vertex based on intensity
        c.getHSL(tempHSL);
        c.setHSL((tempHSL.h + 0.5 * intensity) % 1.0, tempHSL.s, tempHSL.l);

        const scaledIntensity = intensity / intensityDivisor;
        p.line.col[i * 3]     = c.r * scaledIntensity;
        p.line.col[i * 3 + 1] = c.g * scaledIntensity;
        p.line.col[i * 3 + 2] = c.b * scaledIntensity;
      }

      p.line.obj.geometry.attributes.position.needsUpdate = true;
      p.line.obj.geometry.attributes.color.needsUpdate    = true;
    });
  }

  // ─── Points Sync ──────────────────────────────────────────────────────────
  // Copies position & color buffers from each line projection to its paired
  // points cloud so the glowing dots sit exactly on the line vertices.

  function syncPts(lineData, ptsData, n) {
    for (let i = 0; i < n * 3; i++) {
      ptsData.pos[i] = lineData.pos[i];
      ptsData.col[i] = lineData.col[i];
    }
    ptsData.obj.geometry.attributes.position.needsUpdate = true;
    ptsData.obj.geometry.attributes.color.needsUpdate    = true;
  }

  // ─── Dynamic Drift & Rotation ─────────────────────────────────────────────

  function updateDrift() {
    const now = performance.now();
    const t = now * 0.0001; // extremely slow time for position organic drift

    // ── 45s Rotation Target Roll ──
    if (now - lastRotRollTime > 45000) {
      lastRotRollTime = now;
      projections.forEach(p => {
        // Randomize target velocity (e.g. between -0.015 and 0.015)
        p.targetRotVel = (Math.random() - 0.5) * 0.03;
      });
    }

    projections.forEach(p => {
      // 1. Slow lerp velocity towards target velocity
      p.rotVel += (p.targetRotVel - p.rotVel) * 0.005;

      // 2. Apply velocity to rotation
      p.rot += p.rotVel;
      
      p.line.obj.rotation.z = p.rot;
      p.pts.obj.rotation.z  = p.rot;

      // 3. Positional Organic Drift (using simple math.sin/cos time offsets)
      let dx = 0, dy = 0;
      switch (p.id) {
        case 'circle':   dx = Math.sin(t * 1.3) * 0.35; dy = Math.cos(t * 0.9) * 0.25; break;
        case 'line':     dx = Math.cos(t * 1.1) * 0.3;  dy = Math.sin(t * 0.8) * 0.2;  break;
        case 'fishEye':  dx = Math.sin(t * 0.6) * 0.25; dy = Math.cos(t * 1.2) * 0.3;  break;
        case 'curveMap': dx = Math.cos(t * 0.7) * 0.2;  dy = Math.sin(t * 1.0) * 0.35; break;
      }
      p.line.obj.position.set(p.posOffset.x + dx, p.posOffset.y + dy, 0);
      p.pts.obj.position.copy(p.line.obj.position);
    });
  }

  // ─── Animation Loop ──────────────────────────────────────────────────────

  function animate() {
    requestAnimationFrame(animate);

    // Save previous frame's data for sub-step interpolation
    for (let i = 0; i < NUM_POINTS; i++) {
      prevSmoothedData[i] = smoothedData[i];
    }
    projections.forEach(p => {
      p.prevRot = p.rot;
      if (!p.prevPos) p.prevPos = new THREE.Vector3();
      p.prevPos.copy(p.line.obj.position);
    });

    // ── Update audio data (log mapping + ADSR smoothing) ──
    updateAudioData();

    // ── Calculate Audio Bands for Edge Halo ──
    let sumLow = 0, sumMid = 0, sumHigh = 0;
    const third = Math.floor(NUM_POINTS / 3);
    for (let i = 0; i < third; i++) sumLow += smoothedData[i];
    for (let i = third; i < third * 2; i++) sumMid += smoothedData[i];
    for (let i = third * 2; i < NUM_POINTS; i++) sumHigh += smoothedData[i];
    displayMaterial.uniforms.uAudioBands.value.set(
      sumLow / third,
      sumMid / third,
      sumHigh / (NUM_POINTS - third * 2)
    );

    // ── Update drift targets for THIS frame ──
    updateDrift();
    
    // Store the drift targets so they aren't overwritten during sub-steps
    projections.forEach(p => {
      if (!p.targetPos) p.targetPos = new THREE.Vector3();
      p.targetPos.copy(p.line.obj.position);
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  3-PASS RENDER PIPELINE (with SUB-STEPPING)
    // ═══════════════════════════════════════════════════════════════════════

    // Pass 1: Render the 4 projections → sceneRT (Multi-stepped for smooth trails)
    renderer.setRenderTarget(sceneRT);
    renderer.clear();
    renderer.autoClear = false;

    for (let step = 1; step <= SUB_STEPS; step++) {
      const t = step / SUB_STEPS;

      // Lerp audio data
      for (let i = 0; i < NUM_POINTS; i++) {
        stepSmoothedData[i] = prevSmoothedData[i] + (smoothedData[i] - prevSmoothedData[i]) * t;
      }

      // Interpolate rotation and position for smooth in-between frames
      projections.forEach(p => {
        p.line.obj.rotation.z = p.prevRot + (p.rot - p.prevRot) * t;
        p.pts.obj.rotation.z  = p.line.obj.rotation.z;

        p.line.obj.position.lerpVectors(p.prevPos, p.targetPos, t);
        p.pts.obj.position.copy(p.line.obj.position);
      });

      // Update geometry buffers with interpolated data
      updateProjections(stepSmoothedData, SUB_STEPS);
      
      // Sync points
      projections.forEach(p => syncPts(p.line, p.pts, NUM_POINTS + 1));

      // Draw this sub-step
      renderer.render(scene, camera);
    }
    
    // Restore autoClear for future passes
    renderer.autoClear = true;

    // Pass 2: Feedback shader blends (expanded prev trails + fresh scene)
    //         → writeFB, with decay and clamp ≤ 1.0
    feedbackMaterial.uniforms.tPrevFrame.value    = readFB.texture;
    feedbackMaterial.uniforms.tCurrentFrame.value = sceneRT.texture;
    renderer.setRenderTarget(writeFB);
    renderer.clear();
    renderer.render(feedbackScene, quadCamera);

    // Ping-pong swap: what we just wrote becomes the "previous" for next frame
    const tmp = readFB;
    readFB    = writeFB;
    writeFB   = tmp;

    // Pass 3: Display shader (gamma + vignette + halo) → screen
    displayMaterial.uniforms.tTexture.value = readFB.texture;
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(displayScene, quadCamera);
  }

  // ─── Resize Handler ───────────────────────────────────────────────────────

  function onResize() {
    width  = container.clientWidth;
    height = container.clientHeight;
    if (width === 0 || height === 0) return;

    aspect = width / height;
    camera.left   = -frustumSize * aspect / 2;
    camera.right  =  frustumSize * aspect / 2;
    camera.top    =  frustumSize / 2;
    camera.bottom = -frustumSize / 2;
    camera.updateProjectionMatrix();

    renderer.setSize(width, height);

    // Rebuild render targets at new resolution
    sceneRT.dispose();
    feedbackRT_A.dispose();
    feedbackRT_B.dispose();

    sceneRT      = createRT(width, height);
    feedbackRT_A = createRT(width, height);
    feedbackRT_B = createRT(width, height);
    readFB  = feedbackRT_A;
    writeFB = feedbackRT_B;

    // Update feedback shader's resolution uniform (used for blur texel size)
    const pr = renderer.getPixelRatio();
    feedbackMaterial.uniforms.uResolution.value.set(
      Math.floor(width * pr),
      Math.floor(height * pr)
    );
  }

  window.addEventListener('resize', onResize);

  // ─── Start ────────────────────────────────────────────────────────────────
  onResize();
  animate();

  console.log('[Visualizer] TouchDesigner feedback visualizer initialized.');

})();
