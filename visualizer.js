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
      tTexture: { value: null }
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
      '  color *= mix(0.15, 1.0, vig);',
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
  const lineLine = createLineProj(NUM_POINTS);
  const linePts  = createPointsProj(NUM_POINTS, 0.14);
  scene.add(lineLine.obj);
  scene.add(linePts.obj);

  // 3. Fish-Eye — spherical bulge distortion
  const fishLine = createLineProj(NUM_POINTS + 1);
  const fishPts  = createPointsProj(NUM_POINTS + 1, 0.16);
  scene.add(fishLine.obj);
  scene.add(fishPts.obj);

  // 4. Curve Map — sine-wave baseline
  const curvLine = createLineProj(NUM_POINTS);
  const curvPts  = createPointsProj(NUM_POINTS, 0.14);
  scene.add(curvLine.obj);
  scene.add(curvPts.obj);

  // ─── Projection Update Functions ──────────────────────────────────────────
  //
  // Each function writes the CURRENT audio frame into the projection's
  // vertex buffers. Vertex colors are multiplied by `intensity` so that
  // zero amplitude = black = invisible on the black background.
  // This is the "scrolling spectrum" injection point — only the fresh frame
  // is drawn; the feedback loop handles all history/trails.

  function updateCircle() {
    const { pos, col } = circLine;
    const pal    = palettes.circle;
    const radius = BASE_SCALE * 0.45;

    for (let i = 0; i <= NUM_POINTS; i++) {
      const idx       = i % NUM_POINTS;
      const angle     = (i / NUM_POINTS) * Math.PI * 2;
      const intensity = smoothedData[idx];
      const r         = radius + intensity * BASE_SCALE * 0.5;

      pos[i * 3]     = Math.cos(angle) * r;
      pos[i * 3 + 1] = Math.sin(angle) * r;
      pos[i * 3 + 2] = 0;

      // Intensity-gated color: silent bins produce black (invisible)
      const c = lerpColor(pal.low, pal.high, intensity);
      col[i * 3]     = c.r * intensity;
      col[i * 3 + 1] = c.g * intensity;
      col[i * 3 + 2] = c.b * intensity;
    }
    circLine.obj.geometry.attributes.position.needsUpdate = true;
    circLine.obj.geometry.attributes.color.needsUpdate    = true;
  }

  function updateLine() {
    const { pos, col } = lineLine;
    const pal = palettes.line;
    const w   = BASE_SCALE * 1.6;

    for (let i = 0; i < NUM_POINTS; i++) {
      const t         = i / (NUM_POINTS - 1);
      const intensity = smoothedData[i];

      pos[i * 3]     = (t - 0.5) * w;
      pos[i * 3 + 1] = intensity * BASE_SCALE * 0.55;
      pos[i * 3 + 2] = 0;

      const c = lerpColor(pal.low, pal.high, intensity);
      col[i * 3]     = c.r * intensity;
      col[i * 3 + 1] = c.g * intensity;
      col[i * 3 + 2] = c.b * intensity;
    }
    lineLine.obj.geometry.attributes.position.needsUpdate = true;
    lineLine.obj.geometry.attributes.color.needsUpdate    = true;
  }

  function updateFishEye() {
    const { pos, col } = fishLine;
    const pal    = palettes.fishEye;
    const radius = BASE_SCALE * 0.5;

    for (let i = 0; i <= NUM_POINTS; i++) {
      const idx       = i % NUM_POINTS;
      const t         = i / NUM_POINTS;
      const intensity = smoothedData[idx];

      const angle      = (t - 0.5) * Math.PI * 2;
      const bulge      = Math.sin(t * Math.PI);
      const distortion = 1.0 + intensity * 1.6;

      pos[i * 3]     = Math.sin(angle) * radius * distortion;
      pos[i * 3 + 1] = bulge * radius * distortion * 0.8 + intensity * BASE_SCALE * 0.18;
      pos[i * 3 + 2] = 0;

      const c = lerpColor(pal.low, pal.high, intensity);
      col[i * 3]     = c.r * intensity;
      col[i * 3 + 1] = c.g * intensity;
      col[i * 3 + 2] = c.b * intensity;
    }
    fishLine.obj.geometry.attributes.position.needsUpdate = true;
    fishLine.obj.geometry.attributes.color.needsUpdate    = true;
  }

  function updateCurve() {
    const { pos, col } = curvLine;
    const pal = palettes.curveMap;
    const w   = BASE_SCALE * 1.4;

    for (let i = 0; i < NUM_POINTS; i++) {
      const t         = i / (NUM_POINTS - 1);
      const intensity = smoothedData[i];
      const sineBase  = Math.sin(t * Math.PI * 4) * BASE_SCALE * 0.25;

      pos[i * 3]     = (t - 0.5) * w;
      pos[i * 3 + 1] = sineBase + intensity * BASE_SCALE * 0.5;
      pos[i * 3 + 2] = 0;

      const c = lerpColor(pal.low, pal.high, intensity);
      col[i * 3]     = c.r * intensity;
      col[i * 3 + 1] = c.g * intensity;
      col[i * 3 + 2] = c.b * intensity;
    }
    curvLine.obj.geometry.attributes.position.needsUpdate = true;
    curvLine.obj.geometry.attributes.color.needsUpdate    = true;
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
  //
  // Each projection continuously rotates and oscillates its position around
  // its base offset. Because this movement feeds into the FBO feedback loop,
  // the rotation creates spiraling trails and the drift creates flowing,
  // organic interference patterns.

  // Base offset origins for each projection (the "home" position).
  const DRIFT = {
    circle: { x: -1.3, y:  1.2 },
    line:   { x:  1.0, y: -1.4 },
    fish:   { x:  1.5, y:  1.0 },
    curve:  { x: -1.5, y: -1.5 }
  };

  function updateDrift() {
    // performance.now() * 0.0001 → very slow time scale for organic motion
    const t = performance.now() * 0.0001;

    // ── Circle: continuous counter-clockwise rotation + gentle orbit ──
    circLine.obj.rotation.z  = t * 0.5;
    circLine.obj.position.x  = DRIFT.circle.x + Math.sin(t * 1.3) * 0.35;
    circLine.obj.position.y  = DRIFT.circle.y + Math.cos(t * 0.9) * 0.25;
    circPts.obj.rotation.z   = circLine.obj.rotation.z;
    circPts.obj.position.copy(circLine.obj.position);

    // ── Line: gentle pendulum sway ──
    lineLine.obj.rotation.z  = Math.sin(t * 0.7) * 0.15;
    lineLine.obj.position.x  = DRIFT.line.x + Math.cos(t * 1.1) * 0.3;
    lineLine.obj.position.y  = DRIFT.line.y + Math.sin(t * 0.8) * 0.2;
    linePts.obj.rotation.z   = lineLine.obj.rotation.z;
    linePts.obj.position.copy(lineLine.obj.position);

    // ── Fish-Eye: opposite rotation + drifting figure-8 ──
    fishLine.obj.rotation.z  = -t * 0.35;
    fishLine.obj.position.x  = DRIFT.fish.x + Math.sin(t * 0.6) * 0.25;
    fishLine.obj.position.y  = DRIFT.fish.y + Math.cos(t * 1.2) * 0.3;
    fishPts.obj.rotation.z   = fishLine.obj.rotation.z;
    fishPts.obj.position.copy(fishLine.obj.position);

    // ── Curve: slow wobble ──
    curvLine.obj.rotation.z  = Math.cos(t * 0.5) * 0.18;
    curvLine.obj.position.x  = DRIFT.curve.x + Math.cos(t * 0.7) * 0.2;
    curvLine.obj.position.y  = DRIFT.curve.y + Math.sin(t * 1.0) * 0.35;
    curvPts.obj.rotation.z   = curvLine.obj.rotation.z;
    curvPts.obj.position.copy(curvLine.obj.position);
  }

  // ─── Animation Loop ──────────────────────────────────────────────────────

  function animate() {
    requestAnimationFrame(animate);

    // ── Update audio data (log mapping + ADSR smoothing) ──
    updateAudioData();

    // ── Update projection geometries with current audio frame ──
    updateCircle();
    updateLine();
    updateFishEye();
    updateCurve();

    // ── Sync points layers to their line counterparts ──
    syncPts(circLine, circPts, NUM_POINTS + 1);
    syncPts(lineLine, linePts, NUM_POINTS);
    syncPts(fishLine, fishPts, NUM_POINTS + 1);
    syncPts(curvLine, curvPts, NUM_POINTS);

    // ── Apply organic drift & rotation ──
    updateDrift();

    // ═══════════════════════════════════════════════════════════════════════
    //  3-PASS RENDER PIPELINE
    // ═══════════════════════════════════════════════════════════════════════

    // Pass 1: Render the 4 projections (current audio frame) → sceneRT
    renderer.setRenderTarget(sceneRT);
    renderer.clear();
    renderer.render(scene, camera);

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

    // Pass 3: Display shader (gamma + vignette) → screen
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
