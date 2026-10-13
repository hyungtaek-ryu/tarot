// 카드 뒷면 문양 (SVG symbol 하나를 만들어 모든 카드가 <use>로 재사용)

(function buildCardBackSymbol() {
  const W = 100, H = 168, CX = 50, CY = 84;
  const f = (n) => Math.round(n * 100) / 100;

  // 고정 시드 난수 — 모든 카드의 별 배치가 같도록
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  // 별 가루
  let stars = "";
  for (let i = 0; i < 70; i++) {
    const x = 9 + rand() * 82, y = 10 + rand() * 148;
    if (Math.hypot(x - CX, y - CY) < 34) continue;
    const r = 0.18 + rand() * 0.45;
    stars += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" opacity="${f(0.35 + rand() * 0.6)}"/>`;
  }

  // 4갈래 별
  const sparkle = (x, y, s, extra = "") =>
    `<path ${extra} d="M${x} ${y - s} Q${x} ${y} ${x + s} ${y} Q${x} ${y} ${x} ${y + s} Q${x} ${y} ${x - s} ${y} Q${x} ${y} ${x} ${y - s}Z"/>`;

  // 달의 위상: t = 1 보름, 0 반달, 음수 초승달 / mirror 시 그믐 방향
  const moon = (x, y, r, t, mirror = false) => {
    const e = f(r * Math.abs(t)), s = t > 0 ? 0 : 1;
    const lit = `<path d="M${x} ${y - r} A${r} ${r} 0 0 1 ${x} ${y + r} A${e} ${r} 0 0 ${s} ${x} ${y - r}Z" fill="url(#cbGold)"/>`;
    const tf = mirror ? ` transform="translate(${2 * x} 0) scale(-1 1)"` : "";
    return `<g${tf}><circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="url(#cbGold)" stroke-width="0.35"/>${lit}</g>`;
  };
  const moonRow = (y) =>
    moon(32, y, 2.3, -0.45) + moon(41, y, 2.3, 0) + moon(50, y, 2.8, 1) +
    moon(59, y, 2.3, 0, true) + moon(68, y, 2.3, -0.45, true);

  // 별자리 (희미한 선)
  const constellation = (pts) =>
    `<polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="#e9d49a" stroke-width="0.25" opacity="0.45"/>` +
    pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="0.7" fill="#fff4d6"/>`).join("");

  // 중앙 메달리온: 빛줄기 + 12궁 링
  let rays = "";
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    const r1 = 12.5, r2 = i % 2 ? 19 : i % 4 === 0 ? 25 : 22;
    rays += `<line x1="${f(CX + Math.cos(a) * r1)}" y1="${f(CY + Math.sin(a) * r1)}" x2="${f(CX + Math.cos(a) * r2)}" y2="${f(CY + Math.sin(a) * r2)}"/>`;
  }
  let ticks = "";
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
    ticks += `<line x1="${f(CX + Math.cos(a) * 27)}" y1="${f(CY + Math.sin(a) * 27)}" x2="${f(CX + Math.cos(a) * 31)}" y2="${f(CY + Math.sin(a) * 31)}"/>`;
    const b = a + Math.PI / 12;
    ticks += `<circle cx="${f(CX + Math.cos(b) * 29)}" cy="${f(CY + Math.sin(b) * 29)}" r="0.55" fill="url(#cbGold)" stroke="none"/>`;
  }

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <linearGradient id="cbGold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff1c1"/>
      <stop offset="0.45" stop-color="#d9b25c"/>
      <stop offset="0.7" stop-color="#f3d991"/>
      <stop offset="1" stop-color="#9c7531"/>
    </linearGradient>
    <radialGradient id="cbBg" cx="0.5" cy="0.5" r="0.75">
      <stop offset="0" stop-color="#3b2580"/>
      <stop offset="0.45" stop-color="#1d1150"/>
      <stop offset="1" stop-color="#080418"/>
    </radialGradient>
    <radialGradient id="cbHalo" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#b79bff" stop-opacity="0.55"/>
      <stop offset="0.6" stop-color="#6b4bd6" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#6b4bd6" stop-opacity="0"/>
    </radialGradient>
    <symbol id="cardBackArt" viewBox="0 0 ${W} ${H}">
      <rect width="${W}" height="${H}" rx="6" fill="url(#cbBg)"/>
      <ellipse cx="${CX}" cy="${CY}" rx="44" ry="44" fill="url(#cbHalo)"/>
      <g fill="#f6ead0">${stars}</g>
      ${constellation([[16, 30], [22, 36], [20, 45], [27, 50]])}
      ${constellation([[84, 118], [77, 124], [80, 133], [73, 139]])}

      <rect x="3.5" y="3.5" width="93" height="161" rx="4" fill="none" stroke="url(#cbGold)" stroke-width="1.3"/>
      <rect x="6.5" y="6.5" width="87" height="155" rx="2.5" fill="none" stroke="url(#cbGold)" stroke-width="0.4" opacity="0.8"/>
      <g fill="url(#cbGold)">
        ${sparkle(11, 11, 3.2)}${sparkle(89, 11, 3.2)}${sparkle(11, 157, 3.2)}${sparkle(89, 157, 3.2)}
        ${sparkle(24, 70, 1.6, 'opacity="0.8"')}${sparkle(77, 100, 1.6, 'opacity="0.8"')}
        ${sparkle(73, 40, 1.2, 'opacity="0.7"')}${sparkle(25, 128, 1.2, 'opacity="0.7"')}
      </g>

      ${moonRow(21)}
      ${moonRow(147)}

      <g stroke="url(#cbGold)" stroke-width="0.4" fill="none">
        <line x1="50" y1="28" x2="50" y2="50"/>
        <line x1="50" y1="118" x2="50" y2="140"/>
        <path d="M50 35 l2 3 l-2 3 l-2 -3Z" fill="url(#cbGold)"/>
        <path d="M50 127 l2 3 l-2 3 l-2 -3Z" fill="url(#cbGold)"/>
        <circle cx="${CX}" cy="${CY}" r="31" stroke-width="0.6"/>
        <circle cx="${CX}" cy="${CY}" r="27" stroke-width="0.3"/>
        <circle cx="${CX}" cy="${CY}" r="33.5" stroke-width="0.25" stroke-dasharray="0.6 1.4"/>
      </g>
      <g stroke="url(#cbGold)" stroke-width="0.45" opacity="0.9">${ticks}</g>
      <g stroke="url(#cbGold)" stroke-width="0.4" stroke-linecap="round" opacity="0.85">${rays}</g>

      <circle cx="${CX}" cy="${CY}" r="11.5" fill="#0f0828" stroke="url(#cbGold)" stroke-width="0.7"/>
      <g transform="rotate(-25 ${CX} ${CY})">
        <path d="M${CX} ${CY - 8} A8 8 0 1 0 ${CX} ${CY + 8} A6 8 0 1 1 ${CX} ${CY - 8}Z" fill="url(#cbGold)"/>
      </g>
      <g fill="#fff4d6">${sparkle(53.5, 81, 1.8)}</g>
    </symbol>
  </defs>
</svg>`;
  document.body.insertAdjacentHTML("afterbegin", svg);
})();
