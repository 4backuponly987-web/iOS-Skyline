(() => {
  'use strict';

  const isTouch = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
  if (!isTouch) return;

  document.body.classList.add('skyline-mobile');

  // Make the game behave like a native touch surface: long-pressing to use
  // Tight Carve must never select text/images or open a browser callout.
  const blockSelection = (e) => e.preventDefault();
  document.addEventListener('selectstart', blockSelection, { capture: true });
  document.addEventListener('dragstart', blockSelection, { capture: true });
  document.addEventListener('contextmenu', blockSelection, { capture: true });

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const storeKey = 'skyline.mobile.controls.v1';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(storeKey) || '{}') || {}; } catch (_) {}

  const mobile = window.SKYLINE_MOBILE = {
    active: true,
    motionGranted: false,
    motionSeen: false,
    pitch: 0,
    roll: 0,
    rawRoll: 0,
    rawPitch: 0,
    neutralRoll: null,
    neutralPitch: null,
    lastDirection: 1,
    sensitivity: clamp(Number(saved.sensitivity) || 1, 0.55, 1.8),
    // Pitch is intentionally slightly sensitive: full input needs only a
    // modest wrist tilt, so the screen stays easy to see while flying.
    pitchSensitivity: clamp(Number(saved.pitchSensitivity) || 1.15, 0.55, 1.8),
    reverse: !!saved.reverse,
    tightTurn: false,
    tightTurnPointer: null,
    game: null,
  };

  function persist() {
    try { localStorage.setItem(storeKey, JSON.stringify({ sensitivity: mobile.sensitivity, pitchSensitivity: mobile.pitchSensitivity, reverse: mobile.reverse })); } catch (_) {}
  }

  const controls = document.createElement('div');
  controls.id = 'mobileFlightControls';
  controls.innerHTML = `
    <button id="mobileParachute" class="mobile-action" aria-label="Deploy parachute">Parachute</button>
    <button id="mobilePause" class="mobile-action" aria-label="Pause">Pause</button>
    <div id="mobileTiltReadout">Bank <b id="mobileTiltValue">0%</b> · Pitch <b id="mobilePitchValue">0%</b></div>
    <button id="mobileTuck" class="mobile-action" aria-label="Tuck or deploy wings">Tuck</button>
    <div id="mobileRightActions">
      <button id="mobileBarrel" class="mobile-action" aria-label="Barrel roll">Barrel roll</button>
    </div>`;
  document.body.appendChild(controls);

  const setup = document.createElement('div');
  setup.id = 'mobileMotionSetup';
  setup.className = 'open';
  setup.innerHTML = `
    <div class="motion-card">
      <h2>Motion controls</h2>
      <p>Hold your iPhone in <b>landscape</b> at a comfortable viewing angle. That position becomes neutral.</p>
      <div class="motion-diagram">← TILT LEFT / RIGHT TO STEER →<br>↕ TILT FORWARD / BACK TO DIVE OR PULL UP</div>
      <p>You only need small wrist movements. Tuck is on the lower left; Barrel Roll is on the lower right.</p>
      <button id="enableMotion">Enable tilt + calibrate</button>
      <p id="mobileMotionStatus">GitHub Pages uses HTTPS, which is required for iPhone motion sensors.</p>
    </div>`;
  document.body.appendChild(setup);

  const rotate = document.createElement('div');
  rotate.id = 'mobileRotateHint';
  rotate.innerHTML = '<div><b>Rotate iPhone</b>SKYLINE mobile is designed for landscape play.</div>';
  document.body.appendChild(rotate);

  const tuckBtn = document.getElementById('mobileTuck');
  const barrelBtn = document.getElementById('mobileBarrel');
  const chuteBtn = document.getElementById('mobileParachute');
  const pauseBtn = document.getElementById('mobilePause');
  const tiltValue = document.getElementById('mobileTiltValue');
  const pitchValue = document.getElementById('mobilePitchValue');
  const enableMotion = document.getElementById('enableMotion');
  const motionStatus = document.getElementById('mobileMotionStatus');

  function orientationAngle() {
    let a = 0;
    if (screen.orientation && Number.isFinite(screen.orientation.angle)) a = screen.orientation.angle;
    else if (Number.isFinite(window.orientation)) a = Number(window.orientation);
    if (a > 180) a -= 360;
    return a;
  }

  // Convert the natural device beta/gamma axes into left/right tilt relative
  // to the CURRENT screen orientation. This keeps steering correct in either
  // landscape direction.
  function screenRoll(beta, gamma) {
    const theta = orientationAngle() * Math.PI / 180;
    return gamma * Math.cos(theta) - beta * Math.sin(theta);
  }

  // Orthogonal to screenRoll: this is front/back tilt in the CURRENT screen
  // orientation, so it works in either landscape direction.
  function screenPitch(beta, gamma) {
    const theta = orientationAngle() * Math.PI / 180;
    return beta * Math.cos(theta) + gamma * Math.sin(theta);
  }

  function handleOrientation(e) {
    if (!Number.isFinite(e.beta) || !Number.isFinite(e.gamma)) return;
    mobile.motionSeen = true;

    const rawRoll = screenRoll(e.beta, e.gamma);
    const rawPitch = screenPitch(e.beta, e.gamma);
    mobile.rawRoll = rawRoll;
    mobile.rawPitch = rawPitch;
    if (mobile.neutralRoll === null) mobile.neutralRoll = rawRoll;
    if (mobile.neutralPitch === null) mobile.neutralPitch = rawPitch;

    // iPhone landscape sensor sign is opposite the game's roll convention.
    // Negating here makes physical LEFT -> pilot LEFT by default.
    let dRoll = -(rawRoll - mobile.neutralRoll);
    if (mobile.reverse) dRoll *= -1;
    const rollDead = 2.2;
    const rollFull = 23 / mobile.sensitivity;
    const rollMag = Math.abs(dRoll);
    let rollTarget = 0;
    if (rollMag > rollDead) {
      const t = clamp((rollMag - rollDead) / Math.max(1, rollFull - rollDead), 0, 1);
      rollTarget = Math.sign(dRoll) * Math.pow(t, 1.15);
    }
    mobile.roll += (rollTarget - mobile.roll) * 0.24;
    if (Math.abs(mobile.roll) > 0.12) mobile.lastDirection = mobile.roll > 0 ? 1 : -1;

    // Positive screenPitch is the phone pitching toward the player, which maps
    // naturally to pulling the pilot up. The opposite wrist motion dives.
    // Full pitch needs only ~10 degrees at 1.0x, so you never have to tip the
    // display far enough to make the game hard to see.
    const dPitch = rawPitch - mobile.neutralPitch;
    const pitchDead = 1.25;
    const pitchFull = 10 / mobile.pitchSensitivity;
    const pitchMag = Math.abs(dPitch);
    let pitchTarget = 0;
    if (pitchMag > pitchDead) {
      const t = clamp((pitchMag - pitchDead) / Math.max(1, pitchFull - pitchDead), 0, 1);
      pitchTarget = Math.sign(dPitch) * Math.pow(t, 1.08);
    }
    mobile.pitch += (pitchTarget - mobile.pitch) * 0.22;

    tiltValue.textContent = `${Math.round(mobile.roll * 100)}%`;
    pitchValue.textContent = `${Math.round(mobile.pitch * 100)}%`;
  }

  window.addEventListener('deviceorientation', handleOrientation, true);

  function calibrate() {
    mobile.neutralRoll = mobile.rawRoll;
    mobile.neutralPitch = mobile.rawPitch;
    mobile.roll = 0;
    mobile.pitch = 0;
    tiltValue.textContent = '0%';
    pitchValue.textContent = '0%';
    if (mobile.game?.hud) mobile.game.hud.toast('TILT CALIBRATED', 1600);
  }

  async function requestMotion() {
    motionStatus.textContent = 'Requesting motion access…';
    try {
      if (!window.DeviceOrientationEvent) throw new Error('This browser does not expose device orientation sensors.');
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const result = await DeviceOrientationEvent.requestPermission();
        if (result !== 'granted') throw new Error('Motion permission was not granted.');
      }
      mobile.motionGranted = true;
      mobile.neutralRoll = null;
      mobile.neutralPitch = null;
      try { await screen.orientation?.lock?.('landscape'); } catch (_) {}
      motionStatus.textContent = 'Tilt enabled. Hold the phone still for calibration…';
      setTimeout(() => {
        calibrate();
        setup.classList.remove('open');
      }, 420);
    } catch (err) {
      motionStatus.textContent = err?.message || 'Could not enable motion controls.';
    }
  }
  enableMotion.addEventListener('click', requestMotion);

  function updateOrientationClass() {
    const portrait = innerHeight > innerWidth;
    document.body.classList.toggle('mobile-portrait', portrait);
    if (!portrait && mobile.motionGranted) setTimeout(calibrate, 180);
  }
  addEventListener('resize', updateOrientationClass);
  screen.orientation?.addEventListener?.('change', updateOrientationClass);
  updateOrientationClass();

  // ----- empty-screen tight turn -----------------------------------------
  // Desktop uses left mouse hold as a hard-carve modifier. On iPhone, holding
  // any otherwise-unused part of the flight screen does the same thing.
  // Interactive controls and menus are explicitly excluded so this never
  // fights with pitch, Tuck, Barrel Roll, Parachute, Pause or settings.
  const tightTurnInteractive = [
    'button', 'input', 'select', 'textarea', 'a',
    '#mobileRightActions', '#mobileParachute', '#mobilePause',
    '#mobileMotionSetup', '#mobileRotateHint', '.overlay', '.panel', '.pill', '.btn'
  ].join(',');

  function canStartTightTurn(e) {
    const g = mobile.game;
    if (!g || g.mode !== 'fly' || g.paused || g.ui?.stack?.length) return false;
    if (g.pilot?.state === 'ground' || g.pilot?.state === 'canopy') return false;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest?.(tightTurnInteractive)) return false;
    return true;
  }

  window.addEventListener('pointerdown', (e) => {
    if (!canStartTightTurn(e)) return;
    if (mobile.tightTurnPointer !== null) return;
    mobile.tightTurnPointer = e.pointerId;
    mobile.tightTurn = true;
    document.body.classList.add('mobile-tight-turn');
    if (navigator.vibrate) navigator.vibrate(7);
    e.preventDefault();
  }, { capture: true, passive: false });

  function releaseTightTurn(e) {
    if (mobile.tightTurnPointer === null) return;
    if (e && e.pointerId !== mobile.tightTurnPointer) return;
    mobile.tightTurnPointer = null;
    mobile.tightTurn = false;
    document.body.classList.remove('mobile-tight-turn');
  }
  window.addEventListener('pointerup', releaseTightTurn, true);
  window.addEventListener('pointercancel', releaseTightTurn, true);
  window.addEventListener('blur', () => releaseTightTurn(null));

  // Pitch is controlled entirely by forward/back phone tilt.

  // ----- right thumb ------------------------------------------------------
  let tuckPointer = null;
  tuckBtn.addEventListener('pointerdown', (e) => {
    const g = mobile.game;
    if (!g || g.mode !== 'fly' || g.paused) return;
    tuckPointer = e.pointerId;
    tuckBtn.setPointerCapture?.(e.pointerId);
    const p = g.pilot;
    // Tuck doubles as wing deployment: if the wings are stowed, a tap puts
    // them out; once they are out, holding this same button tucks the suit.
    if (p && p.state !== 'ground' && (p.wingsTarget < 0.5 || p.wings < 0.35)) {
      if (p.toggleWings?.()) g.hud?.toast('WINGS OUT', 1200);
      mobile.tuck = false;
    } else {
      mobile.tuck = true;
      tuckBtn.classList.add('held');
    }
    e.preventDefault();
  });
  function releaseTuck(e) {
    if (tuckPointer !== null && e && e.pointerId !== tuckPointer) return;
    tuckPointer = null;
    mobile.tuck = false;
    tuckBtn.classList.remove('held');
  }
  tuckBtn.addEventListener('pointerup', releaseTuck);
  tuckBtn.addEventListener('pointercancel', releaseTuck);

  barrelBtn.addEventListener('pointerdown', (e) => {
    const g = mobile.game;
    if (!g || g.mode !== 'fly' || g.paused || !g.input) return;
    const dir = Math.abs(mobile.roll) > 0.08 ? (mobile.roll > 0 ? 1 : -1) : mobile.lastDirection;
    const action = dir > 0 ? 'rollTrickR' : 'rollTrickL';
    g.input.pressed[action] = true;
    barrelBtn.classList.add('held');
    if (navigator.vibrate) navigator.vibrate(10);
    e.preventDefault();
  });
  const releaseBarrel = () => barrelBtn.classList.remove('held');
  barrelBtn.addEventListener('pointerup', releaseBarrel);
  barrelBtn.addEventListener('pointercancel', releaseBarrel);

  chuteBtn.addEventListener('click', (e) => {
    const g = mobile.game;
    const p = g?.pilot;
    if (!g || g.mode !== 'fly' || g.paused || !p) return;
    // Mobile has a deploy button, not a cut-away button.
    if (p.state !== 'canopy') p.deployCanopy?.();
    e.preventDefault();
  });

  pauseBtn.addEventListener('click', (e) => {
    const g = mobile.game;
    if (!g?.ui) return;
    if (g.ui.stack?.length) g.ui.close();
    else if (g.mode === 'fly') g.ui.openPause();
    e.preventDefault();
  });

  function addMobilePauseControls(g) {
    const overlay = g.ui?.stack?.[g.ui.stack.length - 1];
    const panel = overlay?.querySelector('.panel');
    if (!panel || panel.querySelector('.mobile-pause-controls')) return;
    const box = document.createElement('div');
    box.className = 'mobile-pause-controls';
    box.innerHTML = `
      <h3>Mobile flight</h3>
      <div class="row"><label>Steering tilt sensitivity</label><input class="mobile-sens" type="range" min="0.55" max="1.8" step="0.05" value="${mobile.sensitivity}"><span class="val mobile-sens-val">${mobile.sensitivity.toFixed(2)}×</span></div>
      <div class="row"><label>Pitch tilt sensitivity</label><input class="mobile-pitch-sens" type="range" min="0.55" max="1.8" step="0.05" value="${mobile.pitchSensitivity}"><span class="val mobile-pitch-sens-val">${mobile.pitchSensitivity.toFixed(2)}×</span></div>
      <div class="btnrow"><button class="btn mobile-cal">Recalibrate tilt</button><button class="btn mobile-reverse">Tilt direction: ${mobile.reverse ? 'Reversed' : 'Normal'}</button></div>`;
    const firstH3 = panel.querySelector('h3');
    if (firstH3) panel.insertBefore(box, firstH3);
    else panel.appendChild(box);
    const range = box.querySelector('.mobile-sens');
    const val = box.querySelector('.mobile-sens-val');
    const pitchRange = box.querySelector('.mobile-pitch-sens');
    const pitchVal = box.querySelector('.mobile-pitch-sens-val');
    range.oninput = () => { mobile.sensitivity = Number(range.value); val.textContent = `${mobile.sensitivity.toFixed(2)}×`; persist(); };
    pitchRange.oninput = () => { mobile.pitchSensitivity = Number(pitchRange.value); pitchVal.textContent = `${mobile.pitchSensitivity.toFixed(2)}×`; persist(); };
    box.querySelector('.mobile-cal').onclick = calibrate;
    box.querySelector('.mobile-reverse').onclick = (ev) => {
      mobile.reverse = !mobile.reverse;
      ev.currentTarget.textContent = `Tilt direction: ${mobile.reverse ? 'Reversed' : 'Normal'}`;
      persist();
      calibrate();
    };
  }

  function installGameHooks(g) {
    if (g.__mobileHooksInstalled) return;
    g.__mobileHooksInstalled = true;
    mobile.game = g;

    // Free Fly on desktop begins standing on a cliff and requires Space to
    // step off. Mobile intentionally has no jump button, so Fly starts hot.
    if (g.ui?.titleAction) {
      const originalTitleAction = g.ui.titleAction.bind(g.ui);
      g.ui.titleAction = function(act) {
        if (act === 'fly') {
          document.getElementById('title')?.classList.add('hidden');
          g.launch(g.startPoi, 'hot');
          return;
        }
        if (act === 'tutorial') return; // keyboard tutorial is intentionally omitted on mobile
        return originalTitleAction(act);
      };
    }

    // Apply the two motion-controlled mobile axes after the game's desktop/gamepad
    // input has been built. This keeps desktop support intact in the repo.
    const originalBuildInput = g.buildInput.bind(g);
    g.buildInput = function() {
      const out = originalBuildInput();
      if (g.mode !== 'fly' || g.paused) return out;
      if (g.pilot?.state === 'ground') {
        // No ground movement controls on mobile; mobile launches are airborne.
        out.walkF = 0; out.walkS = 0; out.run = false; out.jump = false;
        return out;
      }
      if (g.pilot?.state === 'canopy') {
        out.roll = mobile.roll;
        out.yaw = mobile.roll * 0.5;
        out.track = mobile.pitch < -0.18 ? Math.abs(mobile.pitch) : 0;
        out.flare = mobile.pitch > 0.18 ? mobile.pitch : 0;
        return out;
      }
      out.pitch = mobile.pitch;
      out.roll = mobile.roll;
      out.yaw = 0;
      out.tuck = mobile.tuck ? 1 : 0;
      out.track = 0;
      out.flare = 0;
      // Hold unused screen space while steering to mirror desktop Mouse0:
      // the carve gets extra bank authority and automatically adds the pull
      // needed to bend the flight path instead of simply dropping altitude.
      const tightCarve = mobile.tightTurn && Math.abs(mobile.roll) > 0.055;
      if (tightCarve) out.pitch = Math.max(out.pitch, 0.9);
      out.hardPull = tightCarve;
      out.hardTurn = tightCarve;
      g._lastRoll = mobile.roll;
      return out;
    };

    // Mobile deliberately exposes only barrel roll. Filter all other trick
    // inputs so an attached keyboard cannot accidentally enable invert/flips.
    if (g.tricks?.update) {
      const originalTrickUpdate = g.tricks.update.bind(g.tricks);
      const blocked = ['flipMod','heliMod','corkscrew','invert','frontFlip','backFlip'];
      g.tricks.update = function(dt, inp, ed, pilot) {
        const safeInp = Object.assign({}, inp);
        const safeEd = Object.assign({}, ed);
        blocked.forEach((k) => { safeInp[k] = false; safeEd[k] = false; });
        return originalTrickUpdate(dt, safeInp, safeEd, pilot);
      };
    }

    // No respawn-point mechanic on iPhone. A retry restarts the current run/race.
    const originalSetSpawn = g.setSpawnHere?.bind(g);
    g.setSpawnHere = function() { return undefined; };
    g.respawn = function() { return g.retry(); };
    void originalSetSpawn;

    // Map: keep the existing map/races, but remove the unusable cliff start
    // and respawn-point list. Hot start remains the default mobile launch.
    if (g.ui?.refreshMapSide) {
      const originalRefreshMap = g.ui.refreshMapSide.bind(g.ui);
      g.ui.refreshMapSide = function() {
        this.launchMode = this.launchMode === 'heli' ? 'heli' : 'hot';
        originalRefreshMap();
        const side = this.mapSide;
        if (!side) return;
        [...side.querySelectorAll('.pill')].forEach((b) => {
          if (/Cliff jump/i.test(b.textContent || '')) b.remove();
        });
        const headings = [...side.querySelectorAll('h3')];
        const respawnHead = headings.find((h) => /^Respawn points/i.test(h.textContent || ''));
        if (respawnHead) {
          let n = respawnHead;
          while (n) { const next = n.nextSibling; n.remove(); n = next; }
        }
      };
    }

    // Pause menu gains calibration/sensitivity settings without adding another
    // in-flight button.
    if (g.ui?.openPause) {
      const originalPause = g.ui.openPause.bind(g.ui);
      g.ui.openPause = function() {
        originalPause();
        addMobilePauseControls(g);
      };
    }

    if (g.hud) g.hud.toast('IPHONE CONTROLS READY', 1800);
  }

  function updateUI() {
    const g = mobile.game;
    const live = !!(g && g.mode === 'fly' && !g.paused && !(g.ui?.stack?.length));
    controls.classList.toggle('live', live);
    controls.style.visibility = live ? 'visible' : 'hidden';
    if (g?.pilot) {
      chuteBtn.disabled = g.pilot.state === 'canopy';
      chuteBtn.textContent = g.pilot.state === 'canopy' ? 'Canopy' : 'Parachute';
      const wingsOut = g.pilot.wingsTarget > 0.5 || g.pilot.wings > 0.35;
      tuckBtn.textContent = wingsOut ? 'Tuck' : 'Deploy wings';
    }
    requestAnimationFrame(updateUI);
  }
  requestAnimationFrame(updateUI);

  function waitForGame() {
    const g = window.SKYLINE;
    if (g && g.ui && g.pilot && g.tricks) installGameHooks(g);
    else setTimeout(waitForGame, 80);
  }
  waitForGame();

  // Offline/online feedback once the game itself exists.
  addEventListener('offline', () => mobile.game?.hud?.toast('OFFLINE MODE', 1800));
  addEventListener('online', () => mobile.game?.hud?.toast('ONLINE', 1200));
})();
