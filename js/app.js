// 달빛 타로 — 타로 점 보는 6단계
// 1 질문 구체화(의도 파악) → 2 셔플 → 3 덱 정돈 및 컷 → 4 뽑기 및 배치 → 5 오픈 및 리딩 → 6 조언 및 마무리

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FULL_DECK = buildDeck();
const SIMILARITY_THRESHOLD = 0.82; // 이 이상이면 같은 사안을 다시 묻는 것으로 의심
const REPEAT_WINDOW_DAYS = 30;     // 같은 질문은 1~3개월 주기 권장 → 30일 안의 반복을 살핀다
const CRISIS_PATTERN = /자살|자해|죽고\s*싶|목숨을?\s*끊|사라지고\s*싶|살기\s*싫|없어지고\s*싶/;

const state = {
  question: "",
  reframed: false,    // 역질문 칩을 골라 들어온 질문인지
  embedding: null,
  intake: null,       // 의도 파악 결과
  category: "기타",
  spreadKey: "three",
  allowReversed: true,
  deck: [],           // [{ card, reversed }] — deck[0]이 맨 위
  riffles: 0,
  washes: 0,
  picked: [],         // deck 인덱스 (선택 순서 = 포지션 순서)
  flipped: new Set(),
  chat: [],           // Gemini 대화 기록
  abort: null,
};

const spread = () => SPREADS[state.spreadKey];

/* ---------- 리딩 기록 (반복 질문 감지용) ---------- */

const ReadingLog = {
  KEY: "tarot.history",
  load() {
    try { return JSON.parse(localStorage.getItem(this.KEY)) || []; } catch { return []; }
  },
  save(list) {
    try { localStorage.setItem(this.KEY, JSON.stringify(list.slice(-30))); } catch { /* 저장 불가 */ }
  },
  add(record) { this.save([...this.load(), record]); },
  clear() { try { localStorage.removeItem(this.KEY); } catch { /* 무시 */ } },
};

function recentReadings(embedding) {
  const now = Date.now();
  return ReadingLog.load()
    .map((r) => {
      const daysAgo = Math.floor((now - r.at) / 86400000);
      const similarity = embedding && r.embedding ? cosine(embedding, r.embedding) : 0;
      return { ...r, daysAgo, similarity, similar: similarity >= SIMILARITY_THRESHOLD };
    })
    .filter((r) => r.daysAgo <= REPEAT_WINDOW_DAYS)
    .sort((a, b) => (b.similar - a.similar) || (b.at - a.at))
    .slice(0, 5);
}

/* ---------- 공통 ---------- */

function setStep(step) {
  document.querySelectorAll("#stepper li").forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle("done", n < step);
    li.classList.toggle("current", n === step);
  });
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
  setStep(Number($(`#${id}`).dataset.step));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function randomInt(max) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

function cardBack(extraClass = "") {
  const el = document.createElement("div");
  el.className = `card-back ${extraClass}`;
  el.innerHTML = `<svg viewBox="0 0 100 168" preserveAspectRatio="none" aria-hidden="true"><use href="#cardBackArt"/></svg>`;
  return el;
}

function directionLabel(reversed) {
  return reversed ? "역방향" : "정방향";
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function resetAll() {
  state.abort?.abort();
  Object.assign(state, {
    reframed: false, embedding: null, intake: null, deck: [], riffles: 0, washes: 0,
    picked: [], flipped: new Set(), chat: [], abort: null, clarifierUsed: false, clarifier: null,
  });
  showScreen("screen-question");
}

/* ---------- 1. 질문 구체화 & 의도 파악 ---------- */

$("#questionForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#questionInput").value.trim();
  if (!q) return;
  runIntake(q, { reframed: false });
});

async function runIntake(question, { reframed }) {
  state.question = question;
  state.reframed = reframed;
  $("#questionInput").value = question;
  $("#intakeEcho").textContent = `“${question}”`;
  $("#intakeChoose").hidden = true;
  showScreen("screen-intake");
  const card = $("#intakeCard");

  // 위기 신호는 AI 판단을 기다리지 않고 바로 안내한다
  if (CRISIS_PATTERN.test(question)) {
    renderIntake({
      status: "blocked", topic: "crisis", suggestions: [],
      message: "지금 많이 힘드신 것 같아요. 이런 마음은 카드로 풀어내기보다, 당신의 이야기를 직접 들어줄 사람과 나누는 게 먼저예요. 혼자 견디지 않으셨으면 해요.",
    });
    return;
  }

  const stopOracle = showOracle(card, [
    "질문을 들여다보고 있어요",
    "지난 리딩의 흐름을 떠올리는 중이에요",
    "이 질문에 어울리는 배열법을 고르고 있어요",
  ], true);
  state.abort = new AbortController();
  try {
    const signal = state.abort.signal;
    state.embedding = await embedText(question, signal);
    const recent = recentReadings(state.embedding);
    const result = await analyzeQuestion({ question, recent, reframed, signal });
    if (reframed && result.status === "reframe") result.status = "ok";
    stopOracle();
    renderIntake(result);
  } catch (e) {
    stopOracle();
    if (e.name === "AbortError") return;
    showError(card, e.message, () => runIntake(question, { reframed }));
  }
}

function renderIntake(result) {
  state.intake = result;
  state.category = result.category || "기타";
  const card = $("#intakeCard");
  card.innerHTML = "";
  card.className = `intake-card ${result.status}`;

  const badge = {
    ok: "질문이 잘 준비되었어요",
    refine: "질문을 조금 더 구체적으로 다듬어 볼까요?",
    reframe: "잠시 숨을 고르고, 질문의 방향을 바꿔 볼까요?",
    blocked: "이 질문은 카드보다 전문가가 먼저예요",
  }[result.status];
  card.append(el("p", "intake-badge", badge), el("p", "intake-msg", result.message));

  if (result.status === "blocked") {
    if (result.topic === "crisis") card.append($("#crisisTemplate").content.cloneNode(true));
    const actions = el("div", "actions");
    const again = el("button", "btn", "다른 질문하기");
    again.onclick = () => { $("#questionInput").value = ""; showScreen("screen-question"); $("#questionInput").focus(); };
    actions.append(again);
    card.append(actions);
    return;
  }

  const suggestions = result.suggestions || [];
  if (result.status === "refine" || result.status === "reframe") {
    const chips = el("div", "chips");
    suggestions.forEach((s) => {
      const chip = el("button", "chip", s);
      chip.onclick = () => {
        if (result.status === "reframe") runIntake(s, { reframed: true });
        else acceptQuestion(s);
      };
      chips.append(chip);
    });
    const custom = el("button", "chip ghost", "직접 입력하기");
    custom.onclick = () => { showScreen("screen-question"); $("#questionInput").focus(); };
    chips.append(custom);
    if (result.status === "refine") {
      const keep = el("button", "chip ghost", "지금 질문 그대로 볼래요");
      keep.onclick = () => acceptQuestion(state.question);
      chips.append(keep);
    }
    card.append(chips);
    if (result.status === "reframe") return; // 같은 질문으로 바로 카드를 뽑지 않는다
  }

  if (result.status === "ok") acceptQuestion(state.question);
}

function acceptQuestion(q) {
  state.question = q;
  $("#intakeEcho").textContent = `“${q}”`;
  $("#intakeCard").querySelector(".chips")?.remove();
  renderSpreadOptions(state.intake?.spread || "three", state.intake?.spreadReason || "");
  $("#intakeChoose").hidden = false;
}

function renderSpreadOptions(recommended, reason) {
  const wrap = $("#spreadOptions");
  wrap.innerHTML = "";
  Object.entries(SPREADS).forEach(([key, s]) => {
    const label = el("label", "spread-option");
    label.innerHTML = `
      <input type="radio" name="spread" value="${key}" ${key === recommended ? "checked" : ""} />
      <span class="spread-card">
        ${key === recommended ? '<em class="rec">AI 추천</em>' : ""}
        <b>${s.name}</b><small>${s.desc}</small>
      </span>`;
    wrap.append(label);
  });
  if (reason) wrap.append(el("p", "spread-reason", `✦ ${reason}`));
}

$("#editQuestionBtn").addEventListener("click", () => {
  showScreen("screen-question");
  $("#questionInput").focus();
});

$("#toShuffleBtn").addEventListener("click", () => {
  state.spreadKey = document.querySelector('input[name="spread"]:checked').value;
  state.allowReversed = $("#reversedToggle").checked;
  // 정/역방향은 덱 상태로 미리 확정 (50:50). 워싱 셔플 때 다시 섞인다
  state.deck = FULL_DECK.map((card) => ({ card, reversed: state.allowReversed && randomInt(2) === 0 }));
  state.riffles = 0;
  state.washes = 0;
  $("#questionEcho1").textContent = `“${state.question}”`;
  updateShuffleCount();
  $("#toCutBtn").disabled = true;
  renderDeckStack();
  showScreen("screen-shuffle");
});

/* ---------- 2. 카드 섞기 ---------- */

const STACK_SIZE = 14;
const restTransform = (k) => `translate(${-k * 0.7}px, ${-k * 0.7}px)`;

function renderDeckStack() {
  const deck = $("#deck");
  deck.innerHTML = "";
  for (let k = 0; k < STACK_SIZE; k++) {
    const c = cardBack("stack-card");
    c.dataset.k = k;
    c.style.zIndex = k;
    c.style.transform = restTransform(k);
    deck.appendChild(c);
  }
}

function updateShuffleCount() {
  const total = state.riffles + state.washes;
  $("#shuffleCount").textContent = total === 0
    ? "아직 섞지 않았어요"
    : `리플 ${state.riffles}회 · 워싱 ${state.washes}회${total >= 3 ? " · 충분하다고 느껴지면 컷으로 넘어가세요" : ""}`;
}

function fisherYates(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 리플 셔플 연출: 반으로 나누기 → 양쪽에서 1~2장씩 번갈아 떨어뜨리기 → 정돈
async function animateRiffle() {
  const deck = $("#deck");
  const cards = [...deck.children].sort((a, b) => a.dataset.k - b.dataset.k);
  const n = cards.length;
  const half = Math.floor(n / 2) + randomInt(3) - 1;
  const left = cards.slice(0, half);
  const right = cards.slice(half);
  const spreadX = Math.min(70, deck.clientWidth * 0.46);

  cards.forEach((c) => { c.style.transition = "transform 0.42s cubic-bezier(.3,.7,.3,1)"; });
  left.forEach((c, j) => { c.style.transform = `translate(${-spreadX - j * 0.5}px, ${6 - j * 0.6}px) rotate(-7deg)`; });
  right.forEach((c, j) => { c.style.transform = `translate(${spreadX - j * 0.5}px, ${-10 - j * 0.6}px) rotate(7deg)`; });
  await sleep(450);

  cards.forEach((c) => { c.style.transition = "transform 0.18s ease-in"; });
  left.forEach((c, j) => { c.style.transform = `translate(${-spreadX * 0.82 - j * 0.5}px, ${2 - j * 0.6}px) rotate(-13deg)`; });
  right.forEach((c, j) => { c.style.transform = `translate(${spreadX * 0.82 - j * 0.5}px, ${2 - j * 0.6}px) rotate(13deg)`; });
  await sleep(200);

  const order = [];
  let li = 0, ri = 0, fromLeft = randomInt(2) === 0;
  while (li < left.length || ri < right.length) {
    const take = 1 + randomInt(2);
    for (let t = 0; t < take; t++) {
      if (fromLeft && li < left.length) order.push(left[li++]);
      else if (!fromLeft && ri < right.length) order.push(right[ri++]);
    }
    fromLeft = !fromLeft;
  }
  const STEP = 48;
  order.forEach((c, k) => {
    c.dataset.k = k;
    c.style.zIndex = k;
    c.style.transition = `transform 0.24s cubic-bezier(.5,0,.6,1.4) ${k * STEP}ms`;
    c.style.transform = restTransform(k);
  });
  await sleep(n * STEP + 260);
  await squareDeck(cards);
}

// 워싱 셔플 연출: 테이블에 흩뿌리기 → 두 손으로 원을 그리며 휘젓기 → 다시 모으기
async function animateWash() {
  const deck = $("#deck");
  const cards = [...deck.children];
  const rMax = Math.max(60, Math.min(150, $("#deckArea").clientWidth / 2 - 70));
  const polar = cards.map(() => ({
    a: Math.random() * Math.PI * 2,
    r: rMax * (0.35 + Math.random() * 0.65),
    rot: Math.random() * 360,
  }));
  const place = (c, p, ms, delay = 0) => {
    c.style.transition = `transform ${ms}ms cubic-bezier(.45,.05,.55,.95) ${delay}ms`;
    c.style.transform = `translate(${Math.cos(p.a) * p.r}px, ${Math.sin(p.a) * p.r * 0.45}px) rotate(${p.rot}deg) scale(0.78)`;
  };

  cards.forEach((c, i) => place(c, polar[i], 520, i * 18));
  await sleep(520 + cards.length * 18);
  for (let round = 0; round < 3; round++) {
    cards.forEach((c, i) => {
      const p = polar[i];
      p.a += 0.9 + Math.random() * 0.4;
      p.r = rMax * (0.35 + Math.random() * 0.65);
      p.rot += 50 + Math.random() * 40;
      place(c, p, 480);
    });
    await sleep(500);
  }

  const order = fisherYates([...cards]);
  order.forEach((c, k) => {
    c.dataset.k = k;
    c.style.zIndex = k;
    c.style.transition = `transform 0.5s cubic-bezier(.3,.7,.3,1) ${k * 22}ms`;
    c.style.transform = restTransform(k);
  });
  await sleep(500 + cards.length * 22);
  await squareDeck(cards);
}

// 덱을 가볍게 톡 쳐서 맞추기
async function squareDeck(cards) {
  cards.forEach((c) => { c.style.transition = ""; });
  $("#deck").animate(
    [{ transform: "none" }, { transform: "translateY(3px) scale(1.03, 0.97)" }, { transform: "none" }],
    { duration: 260, easing: "ease-out" },
  );
  await sleep(280);
}

async function doShuffle(kind) {
  const btns = [$("#riffleBtn"), $("#washBtn"), $("#toCutBtn")];
  btns.forEach((b) => { b.disabled = true; });
  fisherYates(state.deck);
  if (kind === "wash") {
    // 워싱은 카드를 테이블 위에서 돌리며 섞으므로 방향도 다시 섞인다
    if (state.allowReversed) state.deck.forEach((x) => { x.reversed = randomInt(2) === 0; });
    await animateWash();
    state.washes++;
  } else {
    await animateRiffle();
    state.riffles++;
  }
  updateShuffleCount();
  btns.forEach((b) => { b.disabled = false; });
}

$("#riffleBtn").addEventListener("click", () => doShuffle("riffle"));
$("#washBtn").addEventListener("click", () => doShuffle("wash"));

/* ---------- 3. 덱 정돈 및 컷 ---------- */

const cut = { piles: [], order: [], base: [] };

$("#toCutBtn").addEventListener("click", () => {
  cut.base = [...state.deck];
  splitDeck();
  showScreen("screen-cut");
});

function splitDeck() {

  const a = 20 + randomInt(10);
  const b = 20 + randomInt(10);
  cut.piles = [cut.base.slice(0, a), cut.base.slice(a, a + b), cut.base.slice(a + b)];
  cut.order = [];
  $("#cutGuide").textContent = "다시 하나로 합칠 순서대로 묶음을 눌러주세요. 처음 누른 묶음이 맨 위에 올라가요.";
  $("#cutResetBtn").hidden = true;
  $("#toPickBtn").hidden = true;

  const area = $("#cutArea");
  area.innerHTML = "";
  area.classList.remove("gathered");
  cut.piles.forEach((pile, i) => {
    const btn = el("button", "pile");
    btn.dataset.index = i;
    btn.setAttribute("aria-label", `${i + 1}번째 묶음, ${pile.length}장`);
    const stack = el("span", "pile-stack");
    const layers = Math.max(3, Math.round(pile.length / 6));
    for (let k = 0; k < layers; k++) {
      const c = cardBack("pile-card");
      c.style.transform = `translate(${-k * 0.8}px, ${-k * 0.8}px)`;
      stack.append(c);
    }
    btn.append(stack, el("span", "pile-count", `${pile.length}장`), el("span", "pile-order"));
    btn.addEventListener("click", () => choosePile(i, btn));
    area.append(btn);
  });
}

async function choosePile(i, btn) {
  if (cut.order.includes(i) || cut.order.length >= 3) return;
  cut.order.push(i);
  btn.classList.add("chosen");
  btn.querySelector(".pile-order").textContent = cut.order.length;
  if (cut.order.length < 3) return;

  // 고른 순서대로 다시 하나로 합친다
  state.deck = cut.order.flatMap((k) => cut.piles[k]);
  await sleep(350);
  const area = $("#cutArea");
  const center = area.getBoundingClientRect();
  [...area.children].forEach((p) => {
    const r = p.getBoundingClientRect();
    const dx = center.left + center.width / 2 - (r.left + r.width / 2);
    const order = cut.order.indexOf(Number(p.dataset.index));
    p.style.zIndex = 3 - order;
    p.style.transform = `translate(${dx}px, ${-order * 3}px)`;
  });
  area.classList.add("gathered");
  await sleep(700);
  $("#cutGuide").textContent = "덱이 하나로 정돈되었어요. 이제 카드를 펼쳐 볼까요?";
  $("#cutResetBtn").hidden = false;
  $("#toPickBtn").hidden = false;
}

$("#cutResetBtn").addEventListener("click", () => {
  state.deck = [...cut.base];
  splitDeck();
});

$("#toPickBtn").addEventListener("click", () => {
  state.picked = [];
  renderPickGuide();
  renderPickSlots();
  $("#revealBtn").disabled = true;
  showScreen("screen-pick");
  renderFan(true);
});

/* ---------- 4. 스프레드에 맞춰 뽑기 및 배치 ---------- */

function renderPickGuide() {
  const need = spread().positions.length;
  const left = need - state.picked.length;
  $("#pickGuide").textContent = left > 0
    ? `${spread().name} · 직감이 이끄는 카드 ${need}장을 선택하세요 · 남은 카드 ${left}장`
    : "모든 카드를 골랐어요. 선택한 카드를 다시 누르면 취소할 수 있어요.";
}

function fanLayout(width) {
  const total = state.deck.length;
  const rows = width < 520 ? 4 : width < 900 ? 3 : 2;
  const perRow = Math.ceil(total / rows);
  const cardW = Math.max(46, Math.min(84, width / 11));
  const cardH = cardW * 1.68;
  const rowGap = cardH * 0.62;
  const positions = [];
  for (let i = 0; i < total; i++) {
    const r = Math.floor(i / perRow);
    const k = i % perRow;
    const n = Math.min(perRow, total - r * perRow);
    const t = n > 1 ? k / (n - 1) : 0.5;
    const x = t * (width - cardW);
    const y = r * rowGap + Math.pow(t - 0.5, 2) * 4 * cardH * 0.18;
    const rot = (t - 0.5) * 16;
    positions.push({ x, y, rot });
  }
  return { positions, cardW, cardH, height: (rows - 1) * rowGap + cardH * 1.25 };
}

function renderFan(animate = false) {
  const fan = $("#fan");
  const width = fan.clientWidth;
  const { positions, cardW, cardH, height } = fanLayout(width);
  fan.style.height = `${height}px`;
  fan.style.setProperty("--cw", `${cardW}px`);
  fan.style.setProperty("--ch", `${cardH}px`);

  if (animate || fan.children.length !== state.deck.length) {
    fan.innerHTML = "";
    state.deck.forEach((_, i) => {
      const c = cardBack("fan-card");
      c.dataset.index = i;
      c.tabIndex = 0;
      c.setAttribute("role", "button");
      c.setAttribute("aria-label", `카드 ${i + 1}`);
      c.style.setProperty("--x", `${(width - cardW) / 2}px`);
      c.style.setProperty("--y", "0px");
      c.style.setProperty("--rot", "0deg");
      fan.appendChild(c);
    });
  }

  const cards = fan.children;
  const apply = () => {
    positions.forEach((p, i) => {
      const c = cards[i];
      c.style.setProperty("--x", `${p.x}px`);
      c.style.setProperty("--y", `${p.y}px`);
      c.style.setProperty("--rot", `${p.rot}deg`);
      c.style.zIndex = i;
      c.style.transitionDelay = animate ? `${i * 9}ms` : "0ms";
      c.classList.toggle("picked", state.picked.includes(i));
    });
  };
  if (animate) requestAnimationFrame(() => requestAnimationFrame(apply));
  else apply();
}

function togglePick(index) {
  const need = spread().positions.length;
  const at = state.picked.indexOf(index);
  if (at >= 0) state.picked.splice(at, 1);
  else if (state.picked.length < need) state.picked.push(index);
  else return;
  $("#fan").children[index].classList.toggle("picked", state.picked.includes(index));
  renderPickGuide();
  renderPickSlots();
  $("#revealBtn").disabled = state.picked.length !== need;
}

$("#fan").addEventListener("click", (e) => {
  const c = e.target.closest(".fan-card");
  if (c) togglePick(Number(c.dataset.index));
});
$("#fan").addEventListener("keydown", (e) => {
  const c = e.target.closest(".fan-card");
  if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); togglePick(Number(c.dataset.index)); }
});

function renderPickSlots() {
  const wrap = $("#pickSlots");
  wrap.innerHTML = "";
  wrap.dataset.count = spread().positions.length;
  spread().positions.forEach((pos, i) => {
    const slot = el("div", "slot");
    const deckIndex = state.picked[i];
    if (deckIndex !== undefined) {
      const back = cardBack("slot-card");
      back.title = "다시 누르면 선택 취소";
      back.addEventListener("click", () => togglePick(deckIndex));
      slot.appendChild(back);
    } else {
      slot.appendChild(el("div", "slot-empty", i + 1));
    }
    slot.appendChild(el("span", "slot-label", pos.name));
    wrap.appendChild(slot);
  });
}

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if ($("#screen-pick").classList.contains("active")) renderFan(false);
  }, 120);
});

$("#revealBtn").addEventListener("click", () => {
  state.flipped = new Set();
  $("#questionEcho2").textContent = `“${state.question}”`;
  $("#flipGuide").hidden = false;
  $("#flipGuide").textContent = "배치한 순서대로 카드를 한 장씩 뒤집어 보세요.";
  $("#flipAllBtn").hidden = false;
  $("#reading").hidden = true;
  $("#readingBody").innerHTML = "";
  $("#followups").innerHTML = "";
  $("#chatArea").hidden = true;
  $("#closing").hidden = true;
  $("#clarityBox").hidden = true;
  $("#clarityBox").innerHTML = "";
  state.clarifierUsed = false;
  renderTable();
  showScreen("screen-reading");
});

/* ---------- 5. 카드 오픈 및 리딩 ---------- */

function drawnCards() {
  return state.picked.map((i) => state.deck[i]);
}

function renderTable() {
  const table = $("#table");
  const celtic = spread().layout === "celtic";
  table.innerHTML = "";
  table.className = `table${celtic ? " celtic" : ""}`;
  table.dataset.count = state.picked.length;
  drawnCards().forEach((d, i) => {
    const pos = spread().positions[i];
    const item = el("div", `table-item pos-${i + 1}`);
    const label = celtic && i === 0 ? `1. ${pos.name} · 2. ${spread().positions[1].name}(가로)` : `${i + 1}. ${pos.name}`;
    item.innerHTML = `
      <span class="pos-name">${label}</span>
      <button class="flip-card" aria-label="${pos.name} 카드 뒤집기">
        <span class="flip-inner">
          <span class="face back"></span>
          <span class="face front"><img src="${d.card.img}" alt="${d.card.ko}" class="${d.reversed ? "reversed" : ""}" loading="eager" /></span>
        </span>
      </button>
      <span class="card-name"></span>`;
    item.querySelector(".face.back").appendChild(cardBack());
    item.querySelector(".flip-card").addEventListener("click", () => {
      if (state.flipped.has(i)) openZoom(d, i);
      else flipCard(i);
    });
    table.appendChild(item);
  });
  markNextCard();
}

function markNextCard() {
  const next = state.flipped.size;
  [...$("#table").children].forEach((item, i) => item.classList.toggle("next", i === next));
}

function flipCard(i) {
  if (state.flipped.has(i)) return;
  const next = state.flipped.size;
  const items = $("#table").children;
  if (i !== next) {
    // 배치 순서대로만 뒤집는다
    $("#flipGuide").textContent = `순서대로 열어볼게요. ${next + 1}번 “${spread().positions[next].name}” 카드부터 뒤집어 주세요.`;
    items[next].classList.remove("nudge");
    void items[next].offsetWidth;
    items[next].classList.add("nudge");
    return;
  }
  state.flipped.add(i);
  const d = drawnCards()[i];
  const item = items[i];
  item.classList.add("flipped");
  const celtic = spread().layout === "celtic";
  const nameHtml = `<b>${d.card.ko}</b><small>${celtic ? "" : `${d.card.en} · `}${directionLabel(d.reversed)}</small>`;
  if (celtic && i === 1) {
    items[0].querySelector(".card-name").insertAdjacentHTML("beforeend", `<small class="cross-name">2. ${d.card.ko} · ${directionLabel(d.reversed)}</small>`);
  } else {
    item.querySelector(".card-name").innerHTML = nameHtml;
  }
  item.querySelector(".flip-card").setAttribute("aria-label", `${d.card.ko} 크게 보기`);
  markNextCard();
  if (state.flipped.size < state.picked.length) {
    $("#flipGuide").textContent = `다음은 ${state.flipped.size + 1}번 “${spread().positions[state.flipped.size].name}” 카드예요.`;
  } else {
    onAllFlipped();
  }
}

$("#flipAllBtn").addEventListener("click", async () => {
  $("#flipAllBtn").disabled = true;
  for (let i = state.flipped.size; i < state.picked.length; i++) {
    flipCard(i);
    await sleep(state.picked.length >= 10 ? 260 : 380);
  }
  $("#flipAllBtn").disabled = false;
});

async function onAllFlipped() {
  $("#flipGuide").hidden = true;
  $("#flipAllBtn").hidden = true;
  await sleep(800);
  $("#reading").hidden = false;
  $("#reading").scrollIntoView({ behavior: "smooth", block: "start" });
  startReading();
}

async function startReading() {
  const drawn = drawnCards();
  const body = $("#readingBody");
  $("#chatArea").hidden = true;

  const stopOracle = showOracle(body, [
    "카드를 펼쳐 놓고 숨을 고르고 있어요",
    ...drawn.map((d, i) => `${spread().positions[i].name} 자리의 ‘${d.card.ko}’ 그림을 들여다보는 중`),
    "원소와 수트, 숫자의 흐름을 살피고 있어요",
    "카드들 사이에 흐르는 이야기를 엮고 있어요",
    "당신에게 전할 조언을 고르고 있어요",
  ]);
  const startedAt = performance.now();

  state.abort = new AbortController();
  try {
    const kb = await loadKnowledge();
    const prompt = buildReadingPrompt({
      question: state.question, category: state.category,
      spread: spread(), spreadKey: state.spreadKey, drawn, kb,
    });
    state.chat = [{ role: "user", parts: [{ text: prompt }] }];
    const text = await generate({ system: READER_SYSTEM, contents: state.chat, signal: state.abort.signal });
    await sleep(Math.max(0, 3800 - (performance.now() - startedAt)));
    stopOracle();
    const { body: withoutClarity, clarity } = parseClarity(text, drawn.length);
    const { body: reading, suggestions } = splitSuggestions(withoutClarity);
    revealContent(body, renderReading(reading));
    state.chat.push({ role: "model", parts: [{ text }] });
    renderSuggestChips(suggestions);
    renderClarity(clarity);
    $("#chatArea").hidden = false;
    saveReading(reading, drawn);
  } catch (e) {
    stopOracle();
    if (e.name === "AbortError") return;
    showError(body, e.message, startReading);
  }
}

function saveReading(reading, drawn) {
  const flow = reading.split(/^##\s*카드가 그리는 흐름\s*$/m)[1] || reading;
  const summary = flow.replace(/[#>*\-[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
  ReadingLog.add({
    at: Date.now(),
    question: state.question,
    category: state.category,
    spread: state.spreadKey,
    cards: drawn.map((d) => `${d.card.ko}${d.reversed ? "(역)" : ""}`),
    summary,
    embedding: state.embedding,
  });
}

// 수정구 로딩 연출. 메시지를 차례로 바꿔 보여주고, 정지 함수를 돌려준다
function showOracle(container, messages, compact = false) {
  container.innerHTML = `
    <div class="oracle ${compact ? "compact" : ""}" role="status" aria-live="polite">
      <div class="orb" aria-hidden="true">
        <span class="orb-ring"></span>
        <span class="orb-ring inner"></span>
        <span class="orb-core"></span>
        <span class="orb-mist"></span>
      </div>
      <p class="oracle-msg"></p>
    </div>`;
  const msg = container.querySelector(".oracle-msg");
  let i = 0;
  msg.textContent = messages[0];
  const timer = setInterval(() => {
    if (i >= messages.length - 1) return;
    i++;
    msg.classList.add("fade");
    setTimeout(() => { msg.textContent = messages[i]; msg.classList.remove("fade"); }, 400);
  }, 2600);
  return () => clearInterval(timer);
}

// 완성된 결과를 한 번에 넣고, 블록 단위로 차례차례 떠오르게 한다
function revealContent(container, html) {
  container.innerHTML = html;
  [...container.children].forEach((child, i) => {
    child.classList.add("reveal");
    child.style.animationDelay = `${Math.min(i, 12) * 110}ms`;
  });
}

function showError(container, message, retry) {
  container.innerHTML = "";
  const box = el("div", "error-box");
  const actions = el("div", "actions");
  const retryBtn = el("button", "btn primary", "다시 시도");
  retryBtn.onclick = retry;
  actions.append(retryBtn);
  box.append(el("p", "", message), actions);
  container.appendChild(box);
}

// [[CARD:n]] 표시를 기준으로 카드별 섹션을 만들어 그림과 함께 보여준다
function renderReading(text) {
  const drawn = drawnCards();
  const parts = text.split(/\[\[CARD:(\d+)\]\]/);
  let html = parts[0].trim() ? markdown(parts[0]) : "";
  for (let k = 1; k < parts.length; k += 2) {
    const idx = Number(parts[k]) - 1;
    let content = parts[k + 1] || "";
    const tailAt = content.search(/^##\s/m);
    let tail = "";
    if (tailAt >= 0) { tail = content.slice(tailAt); content = content.slice(0, tailAt); }
    const d = drawn[idx];
    html += d
      ? `<section class="card-section">
          <img src="${d.card.img}" alt="${d.card.ko}" class="${d.reversed ? "reversed" : ""}" data-zoom="${idx}" />
          <div>${markdown(content)}</div>
        </section>`
      : markdown(content);
    if (tail) html += markdown(tail);
  }
  return html;
}

$("#readingBody").addEventListener("click", (e) => {
  const img = e.target.closest("img[data-zoom]");
  if (img) openZoom(drawnCards()[Number(img.dataset.zoom)], Number(img.dataset.zoom));
});

/* 대화형 사후 질의 */

function renderSuggestChips(list) {
  const wrap = $("#suggestChips");
  wrap.innerHTML = "";
  list.forEach((s) => {
    const chip = el("button", "chip", s);
    chip.onclick = () => askFollowup(s);
    wrap.append(chip);
  });
}

$("#followupForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#followupInput").value.trim();
  if (!q) return;
  $("#followupInput").value = "";
  askFollowup(q);
});

function askFollowup(q) {
  $("#chatArea").hidden = true;
  const qa = el("div", "qa");
  qa.append(el("p", "q", q), el("div", "a"));
  $("#followups").appendChild(qa);
  const answer = qa.querySelector(".a");
  qa.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const userTurn = { role: "user", parts: [{ text: buildFollowupPrompt(q) }] };
  const ask = async () => {
    const stopOracle = showOracle(answer, ["펼쳐진 카드에게 다시 물어보고 있어요", "답을 가다듬는 중이에요"], true);
    const startedAt = performance.now();
    state.abort = new AbortController();
    try {
      const text = await generate({ system: READER_SYSTEM, contents: [...state.chat, userTurn], signal: state.abort.signal });
      await sleep(Math.max(0, 2200 - (performance.now() - startedAt)));
      stopOracle();
      const { body, suggestions } = splitSuggestions(parseClarity(text, 0).body);
      revealContent(answer, markdown(body.replace(/\[\[CARD:\d+\]\]/g, "")));
      state.chat.push(userTurn, { role: "model", parts: [{ text }] });
      renderSuggestChips(suggestions);
      $("#chatArea").hidden = false;
    } catch (err) {
      stopOracle();
      if (err.name === "AbortError") return;
      showError(answer, err.message, ask);
    }
  };
  ask();
}

/* 명확성 판정 — 미정이면 그 자체를 안내하고, 정보가 빈 자리가 있을 때만 보조 카드를 허용한다 */

function renderClarity(clarity) {
  const box = $("#clarityBox");
  box.innerHTML = "";
  box.className = "clarity";
  if (clarity.type === "undecided") {
    box.classList.add("undecided");
    box.innerHTML = `<p><span class="clarity-icon" aria-hidden="true">☁</span>
      이 배열은 결론보다 <b>아직 정해지지 않은 흐름</b>을 보여주고 있어요.
      애매함 자체가 지금의 메시지이고, 당신의 선택이 방향을 정하게 돼요.</p>`;
    box.hidden = false;
  } else if (clarity.type === "clarify" && !state.clarifierUsed) {
    const pos = spread().positions[clarity.pos];
    box.classList.add("clarify");
    box.innerHTML = `
      <p><span class="clarity-icon" aria-hidden="true">✦</span>
        <b>${clarity.pos + 1}번 “${pos.name}”</b> 자리가 아직 선명하지 않아요.</p>
      ${clarity.reason ? `<p class="clarity-reason"></p>` : ""}
      <p class="clarity-sub">남은 카드 중 한 장을 더 골라 이 자리를 비춰볼 수 있어요. 보조 카드는 한 번만 뽑을 수 있어요.</p>
      <div class="actions"><button class="btn primary" id="clarifierBtn">보조 카드 한 장 고르기</button></div>`;
    if (clarity.reason) box.querySelector(".clarity-reason").textContent = clarity.reason;
    box.querySelector("#clarifierBtn").onclick = () => showClarifierStrip(clarity.pos);
    box.hidden = false;
  } else {
    box.hidden = true;
  }
}

function showClarifierStrip(posIndex) {
  const box = $("#clarityBox");
  const pos = spread().positions[posIndex];
  const remaining = state.deck.map((_, i) => i).filter((i) => !state.picked.includes(i));
  box.innerHTML = `
    <p>마음을 가라앉히고, <b>“${pos.name}”</b>을(를) 비춰줄 카드 한 장을 골라주세요.</p>
    <div class="clarify-strip" role="list"></div>`;
  const strip = box.querySelector(".clarify-strip");
  remaining.forEach((deckIndex, k) => {
    const c = cardBack("strip-card");
    c.style.zIndex = k;
    c.tabIndex = 0;
    c.setAttribute("role", "button");
    c.setAttribute("aria-label", `남은 카드 ${k + 1}`);
    const choose = () => {
      if (state.clarifierUsed) return;
      state.clarifierUsed = true;
      revealClarifier(deckIndex, posIndex);
    };
    c.addEventListener("click", choose);
    c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); } });
    strip.append(c);
  });
  $("#chatArea").hidden = true;
  box.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function revealClarifier(deckIndex, posIndex) {
  const d = state.deck[deckIndex];
  const pos = spread().positions[posIndex];
  state.clarifier = { d, posIndex };
  const box = $("#clarityBox");
  box.innerHTML = `
    <div class="clarifier-card">
      <span class="pos-name">보조 카드 · ${pos.name} 보충</span>
      <span class="flip-card" aria-hidden="true">
        <span class="flip-inner">
          <span class="face back"></span>
          <span class="face front"><img src="${d.card.img}" alt="${d.card.ko}" class="${d.reversed ? "reversed" : ""}" /></span>
        </span>
      </span>
      <span class="card-name"><b>${d.card.ko}</b><small>${d.card.en} · ${directionLabel(d.reversed)}</small></span>
    </div>`;
  box.querySelector(".face.back").appendChild(cardBack());
  await sleep(120);
  box.querySelector(".clarifier-card").classList.add("flipped");
  await sleep(1000);

  const qa = el("div", "qa clarifier-qa");
  const answer = el("div", "a");
  qa.append(answer);
  $("#followups").appendChild(qa);
  qa.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const ask = async () => {
    const stopOracle = showOracle(answer, [`보조 카드가 “${pos.name}” 자리를 비추는 중이에요`, "흐름을 다시 엮고 있어요"], true);
    const startedAt = performance.now();
    state.abort = new AbortController();
    try {
      const kb = await loadKnowledge();
      const userTurn = { role: "user", parts: [{ text: buildClarifierPrompt({ d, posIndex, spread: spread(), category: state.category, kb }) }] };
      const text = await generate({ system: READER_SYSTEM, contents: [...state.chat, userTurn], signal: state.abort.signal });
      await sleep(Math.max(0, 2600 - (performance.now() - startedAt)));
      stopOracle();
      const { body, suggestions } = splitSuggestions(parseClarity(text, 0).body);
      revealContent(answer, `<section class="card-section">
          <img src="${d.card.img}" alt="${d.card.ko}" class="${d.reversed ? "reversed" : ""}" data-clarifier="1" />
          <div>${markdown(body.replace(/\[\[CARD:\d+\]\]/g, ""))}</div>
        </section>`);
      state.chat.push(userTurn, { role: "model", parts: [{ text }] });
      renderSuggestChips(suggestions);
      $("#chatArea").hidden = false;
    } catch (err) {
      stopOracle();
      if (err.name === "AbortError") return;
      showError(answer, err.message, ask);
    }
  };
  ask();
}

$("#followups").addEventListener("click", (e) => {
  if (e.target.closest("img[data-clarifier]") && state.clarifier) openZoom(state.clarifier.d);
});

/* ---------- 6. 조언 도출 및 마무리 ---------- */

$("#closeReadingBtn").addEventListener("click", async () => {
  $("#chatArea").hidden = true;
  setStep(6);
  const table = $("#table");
  table.scrollIntoView({ behavior: "smooth", block: "center" });
  await sleep(400);
  // 카드를 다시 뒷면으로 돌려 번호순으로 한데 모은다
  const items = [...table.children];
  items.forEach((item) => item.classList.remove("flipped", "next"));
  await sleep(700);
  const box = table.getBoundingClientRect();
  items.forEach((item, i) => {
    const r = item.querySelector(".flip-card").getBoundingClientRect();
    const dx = box.left + box.width / 2 - (r.left + r.width / 2);
    const dy = box.top + box.height / 2 - (r.top + r.height / 2);
    item.style.transition = `transform 0.6s cubic-bezier(.3,.7,.3,1) ${i * 70}ms, opacity 0.6s ${i * 70 + 300}ms`;
    item.style.zIndex = 20 - i;
    item.style.transform = `translate(${dx}px, ${dy - i * 1.5}px)`;
  });
  table.classList.add("tidied");
  await sleep(700 + items.length * 70);
  $("#closing").hidden = false;
  $("#closing").classList.add("reveal");
  $("#closing").scrollIntoView({ behavior: "smooth", block: "center" });
});

/* ---------- 간단한 마크다운 렌더러 ---------- */

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function inline(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>");
}

function markdown(src) {
  const lines = src.replace(/\r/g, "").split("\n");
  let html = "";
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { html += `<p>${para.map(inline).join("<br>")}</p>`; para = []; } };
  const flushList = () => { if (list) { html += `</${list}>`; list = null; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara(); flushList();
      const level = Math.min(4, m[1].length + 1);
      html += `<h${level}>${inline(m[2])}</h${level}>`;
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      flushPara();
      if (list !== "ul") { flushList(); html += "<ul>"; list = "ul"; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (list !== "ol") { flushList(); html += "<ol>"; list = "ol"; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara(); flushList();
      html += `<blockquote>${inline(m[1])}</blockquote>`;
    } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushPara(); flushList();
      html += "<hr>";
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList();
  return html;
}

/* ---------- 카드 확대 ---------- */

function openZoom(d, index) {
  const img = $("#zoomImg");
  img.src = d.card.img;
  img.alt = d.card.ko;
  img.classList.toggle("reversed", d.reversed);
  const c = d.card;
  const pos = index !== undefined ? spread().positions[index] : null;
  const meta = c.major
    ? `${c.arcana} ${c.number}번 · ${c.astro}`
    : `${c.arcana} · ${c.numerology}`;
  $("#zoomInfo").innerHTML = `
    ${pos ? `<p class="meta">${index + 1}. ${pos.name}</p>` : ""}
    <h3>${c.ko} <small>${c.en}</small></h3>
    <p class="meta">${meta} · ${directionLabel(d.reversed)}</p>
    <p>${d.reversed ? c.rev : c.up}</p>
    <p class="symbols">${c.symbols}</p>`;
  $("#zoomDialog").showModal();
}

$("#zoomDialog").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

/* ---------- 설정 ---------- */

// API 키는 Vercel 환경변수에서 관리하므로, 설정 창에는 리딩 기록 관리만 남긴다
$("#settingsBtn").addEventListener("click", () => {
  $("#historyCount").textContent = ReadingLog.load().length;
  $("#settingsDialog").showModal();
});

$("#clearHistoryBtn").addEventListener("click", () => {
  ReadingLog.clear();
  $("#historyCount").textContent = "0";
});

/* ---------- 기타 ---------- */

$("#homeBtn").addEventListener("click", resetAll);
$("#restartBtn").addEventListener("click", () => {
  $("#questionInput").value = "";
  resetAll();
  $("#questionInput").focus();
});

setStep(1);
loadKnowledge(); // 지식 베이스 미리 불러오기
