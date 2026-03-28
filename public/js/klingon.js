/* ═══════════════════════════════════════════════════
   klingon.js — Klingon Easter Egg Effects
   ═══════════════════════════════════════════════════ */
'use strict';

const KlingonFX = {
  _active: false,

  /** Play a synthesized Klingon-style sound effect */
  _playSound(type) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();

      if (type === 'enter') {
        // Dramatic Klingon horn/gong — deep rumble + metallic hit
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        const gain2 = ctx.createGain();

        osc1.type = 'sawtooth';
        osc1.frequency.setValueAtTime(80, ctx.currentTime);
        osc1.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.8);
        gain1.gain.setValueAtTime(0.3, ctx.currentTime);
        gain1.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 1.2);

        osc2.type = 'square';
        osc2.frequency.setValueAtTime(220, ctx.currentTime);
        osc2.frequency.exponentialRampToValueAtTime(110, ctx.currentTime + 0.3);
        gain2.gain.setValueAtTime(0.15, ctx.currentTime);
        gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);

        osc1.connect(gain1).connect(ctx.destination);
        osc2.connect(gain2).connect(ctx.destination);
        osc1.start(); osc2.start();
        osc1.stop(ctx.currentTime + 1.2);
        osc2.stop(ctx.currentTime + 0.5);

        // Speak "Qapla'!" using speech synthesis
        setTimeout(() => {
          if ('speechSynthesis' in window) {
            const u = new SpeechSynthesisUtterance("Kapla!");
            u.rate = 0.8;
            u.pitch = 0.6;
            u.volume = 0.8;
            speechSynthesis.speak(u);
          }
        }, 600);

      } else if (type === 'exit') {
        // Triumphant exit — rising tone
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.4);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.6);

        setTimeout(() => {
          if ('speechSynthesis' in window) {
            const phrases = [
              "Heg-bah! Today is a good day to die!",
              "Kapla! Glory to the Empire!",
              "May you die well, warrior!",
              "Kah-plah! Victory or death!",
            ];
            const u = new SpeechSynthesisUtterance(phrases[Math.floor(Math.random() * phrases.length)]);
            u.rate = 0.85;
            u.pitch = 0.5;
            u.volume = 0.8;
            speechSynthesis.speak(u);
          }
        }, 300);
      }

      setTimeout(() => ctx.close(), 3000);
    } catch {}
  },

  /** Full-screen Klingon activation animation */
  activate() {
    if (this._active) return;
    this._active = true;

    this._playSound('enter');

    // Create overlay
    const overlay = document.createElement('div');
    overlay.id = 'klingon-overlay';
    overlay.innerHTML = `
      <div class="klingon-emblem">
        <div class="klingon-symbol">⚔️</div>
        <div class="klingon-title">tlhIngan maH!</div>
        <div class="klingon-subtitle">We are Klingons!</div>
        <div class="klingon-stars"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Generate floating stars
    const starsEl = overlay.querySelector('.klingon-stars');
    for (let i = 0; i < 30; i++) {
      const star = document.createElement('div');
      star.className = 'klingon-star';
      star.style.left = Math.random() * 100 + '%';
      star.style.top = Math.random() * 100 + '%';
      star.style.animationDelay = (Math.random() * 2) + 's';
      star.style.animationDuration = (1 + Math.random() * 2) + 's';
      starsEl.appendChild(star);
    }

    // Add red tint to body
    document.body.classList.add('klingon-mode');

    // Remove overlay after animation
    setTimeout(() => {
      overlay.classList.add('klingon-fade-out');
      setTimeout(() => overlay.remove(), 800);
    }, 2500);
  },

  /** Klingon deactivation — farewell */
  deactivate() {
    if (!this._active) return;
    this._active = false;

    document.body.classList.remove('klingon-mode');
    this._playSound('exit');

    // Quick farewell toast
    const farewell = document.createElement('div');
    farewell.className = 'klingon-farewell';
    farewell.innerHTML = `
      <span class="klingon-farewell-icon">⚔️</span>
      <span>Qapla'! <span class="text-muted">Today is a good day to die!</span></span>
    `;
    document.body.appendChild(farewell);
    setTimeout(() => {
      farewell.classList.add('klingon-farewell-out');
      setTimeout(() => farewell.remove(), 600);
    }, 2500);
  },
};

window.KlingonFX = KlingonFX;
