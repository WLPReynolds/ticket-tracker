// easter-eggs.js — Seasonal effects.
// Part of the ticket tracker PWA. Read CODEMAP.md first: it lists what each file owns and the load order.

// Easter eggs — purely decorative, never load-bearing. Appended straight to
// document.body (not #app), so a subsequent render() call — which wipes and
// rebuilds #app's innerHTML wholesale — can't cut an animation short partway
// through. Runs once per app open (called once from init(), below), checked
// against the device's local date. pointer-events:none throughout so these
// never intercept a tap on the real UI underneath. Everything here is
// wrapped so a failure can't break app startup.
function runSeasonalEasterEgg(){
  try{
    const now = new Date();
    const month = now.getMonth(); // 0-indexed
    const date = now.getDate();
    if (month === 9 && date === 31){ // Halloween
      spawnHalloweenGhost();
    } else if (month === 10 && date === 5){ // Bonfire Night
      spawnBonfireFireworks();
    }
  }catch(e){ /* decorative only — swallow and move on */ }
}

function spawnHalloweenGhost(){
  const vw = window.innerWidth, vh = window.innerHeight;
  const sizeW = Math.max(160, Math.min(260, vw * 0.5));
  const sizeH = sizeW * 1.1;

  const sides = ['top', 'bottom', 'left', 'right'];
  const startSide = sides[Math.floor(Math.random() * 4)];
  let endSide;
  do{ endSide = sides[Math.floor(Math.random() * 4)]; } while (endSide === startSide);

  // Keeps the ghost's start/end point away from the extreme corners of
  // whichever edge it's crossing, so the drift reads as coming from a side
  // rather than clipping awkwardly out of a corner.
  function pointFor(side){
    const margin = 0.15;
    const rand = margin + Math.random() * (1 - 2 * margin);
    switch (side){
      case 'top': return { x: vw * rand - sizeW / 2, y: -sizeH };
      case 'bottom': return { x: vw * rand - sizeW / 2, y: vh };
      case 'left': return { x: -sizeW, y: vh * rand - sizeH / 2 };
      default: return { x: vw, y: vh * rand - sizeH / 2 };
    }
  }

  const start = pointFor(startSide);
  const end = pointFor(endSide);

  const ghost = document.createElement('div');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.cssText = `position:fixed; top:0; left:0; width:${sizeW}px; height:${sizeH}px; pointer-events:none; z-index:99999; will-change:transform,opacity;`;
  // Gradient fill fading from ~60% opacity at the top to near-0% at the
  // tail, plus a slight blur on the whole shape — reads as a translucent
  // wisp rather than a solid sprite. The container's own opacity is
  // additionally animated in/out below, layering a fade on top of that.
  ghost.innerHTML = `<svg viewBox="0 0 100 110" width="100%" height="100%">
    <defs>
      <linearGradient id="eeGhostFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#f4f2ea" stop-opacity="0.62"/>
        <stop offset="55%" stop-color="#f4f2ea" stop-opacity="0.42"/>
        <stop offset="100%" stop-color="#f4f2ea" stop-opacity="0.06"/>
      </linearGradient>
      <filter id="eeGhostBlur" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="1.1"/>
      </filter>
    </defs>
    <path d="M50 6 C22 6 8 28 8 55 L8 95 C8 100 14 101 17 97 L24 88 C26 85 30 85 32 88 L38 96 C40 99 44 99 46 96 L50 90 L54 96 C56 99 60 99 62 96 L68 88 C70 85 74 85 76 88 L83 97 C86 101 92 100 92 95 L92 55 C92 28 78 6 50 6 Z" fill="url(#eeGhostFade)" filter="url(#eeGhostBlur)"/>
    <ellipse cx="36" cy="46" rx="5" ry="7" fill="#20222c" opacity="0.35"/>
    <ellipse cx="64" cy="46" rx="5" ry="7" fill="#20222c" opacity="0.35"/>
    <path d="M40 64 Q50 71 60 64" stroke="#20222c" stroke-width="2.5" fill="none" stroke-linecap="round" opacity="0.3"/>
  </svg>`;
  document.body.appendChild(ghost);

  const duration = 8000;
  const anim = ghost.animate([
    { transform: `translate(${start.x}px, ${start.y}px)`, opacity: 0 },
    { opacity: 1, offset: 0.12 },
    { opacity: 1, offset: 0.88 },
    { transform: `translate(${end.x}px, ${end.y}px)`, opacity: 0 }
  ], { duration, easing: 'ease-in-out', fill: 'forwards' });

  const cleanup = () => { if (ghost.isConnected) ghost.remove(); };
  anim.onfinish = cleanup;
  setTimeout(cleanup, duration + 1000); // safety net if onfinish is ever missed (e.g. backgrounded mid-animation)
}

function spawnBonfireFireworks(){
  const container = document.createElement('div');
  container.setAttribute('aria-hidden', 'true');
  container.style.cssText = 'position:fixed; inset:0; pointer-events:none; z-index:99999; overflow:hidden;';
  document.body.appendChild(container);

  const colors = ['#e0524a', '#f2a93b', '#3f9e5c', '#3f7fd8', '#d4af37', '#c77dd8'];
  const burstCount = 5;
  const totalDuration = 7500;

  for (let i = 0; i < burstCount; i++){
    const delay = Math.random() * 4000; // staggered across the first 4s, leaving room for the last burst to fully fade within the 7.5s total
    setTimeout(() => spawnFireworkBurst(container, colors), delay);
  }

  setTimeout(() => { if (container.isConnected) container.remove(); }, totalDuration + 500);
}

function spawnFireworkBurst(container, colors){
  if (!container.isConnected) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const cx = vw * (0.15 + Math.random() * 0.7);
  const cy = vh * (0.12 + Math.random() * 0.5); // upper-middle of the screen, like a real firework
  const color = colors[Math.floor(Math.random() * colors.length)];
  const particleCount = 14;
  const radius = 60 + Math.random() * 40;

  for (let p = 0; p < particleCount; p++){
    const angle = (p / particleCount) * Math.PI * 2;
    const dx = Math.cos(angle) * radius;
    const dy = Math.sin(angle) * radius;
    const dot = document.createElement('div');
    dot.style.cssText = `position:absolute; left:${cx}px; top:${cy}px; width:4px; height:4px; border-radius:50%; background:${color}; box-shadow:0 0 4px ${color};`;
    container.appendChild(dot);
    const anim = dot.animate([
      { transform: 'translate(0,0)', opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px)`, opacity: 0 }
    ], { duration: 1000 + Math.random() * 400, easing: 'ease-out', fill: 'forwards' });
    const cleanup = () => { if (dot.isConnected) dot.remove(); };
    anim.onfinish = cleanup;
    setTimeout(cleanup, 1600);
  }
}
