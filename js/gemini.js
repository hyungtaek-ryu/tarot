// Gemini 파이프라인
// 1) 의도 파악 & 스프레드 결정  2) (카드 추출은 앱 로직에서 crypto 난수로)
// 3) 지식 베이스 주입  4) 리딩 생성  5) 사후 질의(챗)

// API 키는 서버(Vercel 환경변수)에만 있고, 브라우저는 /api/gemini 프록시만 호출한다
const PROXY_URL = "/api/gemini";

class GeminiError extends Error {}

async function geminiPost(method, payload, signal) {
  if (location.protocol === "file:") {
    throw new GeminiError("파일로 직접 열면 AI 서버에 연결할 수 없어요. Vercel에 배포한 주소(또는 vercel dev)로 열어주세요.");
  }
  let res;
  try {
    res = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, payload }),
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new GeminiError("네트워크 연결에 실패했어요. 인터넷 연결을 확인해주세요.");
  }
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error?.message || ""; } catch { /* 본문 없음 */ }
    let msg = `요청 실패 (${res.status})`;
    if (detail === "SERVER_KEY_MISSING") msg = "서버에 API 키가 설정되지 않았어요. Vercel 환경변수 GEMINI_API_KEY를 확인해주세요.";
    else if (detail === "RATE_LIMITED" || res.status === 429) msg = "요청이 너무 많아요. 잠시 후 다시 시도해주세요.";
    else if (res.status === 400 && /API key/i.test(detail)) msg = "서버의 API 키가 올바르지 않아요. 관리자에게 문의해주세요.";
    else if (res.status === 404) msg = "AI 모델을 찾을 수 없어요. Vercel 환경변수 GEMINI_MODEL을 확인해주세요.";
    else if (res.status === 504) msg = "응답이 너무 오래 걸렸어요. 다시 시도해주세요.";
    throw new GeminiError(msg);
  }
  return res.json();
}

async function generate({ system, contents, json = null, temperature = 0.9, signal }) {
  const generationConfig = { temperature };
  if (json) Object.assign(generationConfig, { responseMimeType: "application/json", responseSchema: json });
  const data = await geminiPost("generateContent", {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig,
  }, signal);

  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("");
  if (!text) {
    throw new GeminiError(data.promptFeedback?.blockReason || cand?.finishReason === "SAFETY"
      ? "질문 내용이 안전 정책에 의해 차단되었어요. 질문을 바꿔서 다시 시도해주세요."
      : "응답을 받지 못했어요. 다시 시도해주세요.");
  }
  return text;
}

/* ---------- 질문 유사도 (임베딩) ---------- */

async function embedText(text, signal) {
  try {
    const data = await geminiPost("embedContent", {
      content: { parts: [{ text }] },
      taskType: "SEMANTIC_SIMILARITY",
      outputDimensionality: 256,
    }, signal);
    return data.embedding?.values || null;
  } catch (e) {
    if (e.name === "AbortError") throw e;
    return null; // 임베딩을 못 쓰면 LLM 판단만으로 진행
  }
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/* ---------- 1단계: 의도 파악 & 스프레드 결정 ---------- */

const INTAKE_SYSTEM = `당신은 타로 상담의 첫 단계(의도 파악)를 맡은, 융 심리학 기반의 공감 중심 상담가입니다.
카드를 뽑기 전에 질문을 살펴보고, 아래 네 가지 중 하나로 판단해 JSON으로만 답합니다.

[status 판단 기준 — 위에서부터 우선 적용]
1. "blocked": 질병 진단·치료, 극단적인 투자·도박성 재정 결정, 법적 소송의 결과, 자해·자살·생명 위협과 관련된 질문.
   타로 해석을 정중히 거절하고, 마음을 먼저 알아준 뒤 알맞은 전문가(의사, 변호사, 재무 전문가, 상담센터)를 안내하세요.
   자해·자살 관련이면 topic을 "crisis"로 두고, 무엇보다 질문자의 안전을 먼저 걱정하세요.
   ※ 건강 관련이라고 모두 막지 않습니다. 의학적 판단을 카드에 맡기는 질문만 blocked입니다.
     - blocked 예: "이 증상이 무슨 병인가요?", "임신했는지 알려주세요", "이 약을 먹어도 될까요?", "수술을 받아야 할까요?", "유산 위험이 있나요?"
     - 리딩 가능 예: "올해 아이가 생길까요?", "임신 준비를 하는 지금 내 마음은 어떤가요?", "출산을 앞두고 어떤 마음가짐이 필요할까요?",
       "난임으로 지친 나에게 필요한 조언은?", "건강 관리를 위해 어떤 태도가 필요할까요?"
       → 임신·출산·건강을 둘러싼 흐름, 감정, 관계, 마음가짐을 묻는 질문은 ok 또는 refine으로 받아 주세요.
2. "reframe": [최근 리딩 기록]에 같은 사안을 30일 안에 다시 묻는 질문이 있고, 원하는 답을 얻으려 반복하는 것으로 보일 때.
   (임베딩 유사도가 높다는 참고 정보가 있으면 더 무게를 두되, 사안 자체가 다르면 reframe이 아닙니다.)
   - 판단·지적 금지: "방금 물어보셨잖아요", "반복하지 마세요" 같은 말은 절대 쓰지 않습니다.
   - "결과를 듣고 마음이 많이 쓰이셨나 봐요"처럼 감정 수용(Validation)으로 시작합니다.
   - "흔들린 물은 흐려져 바닥이 보이지 않는다"처럼 비유로 타로의 원리를 부드럽게 설명합니다.
   - 상대의 속마음(통제 밖)에서 나의 행동·태도·심리(통제 안)로 질문의 주어를 바꾼 역질문 2~3개를 suggestions에 넣습니다.
3. "refine": 대상·기간·맥락이 빠져 모호하거나, 단순 예/아니오 질문일 때.
   원래 의도를 유지하면서 기간·대상·맥락이 담긴, 흐름이나 조언을 묻는 열린 질문 2~3개를 suggestions에 넣습니다.
4. "ok": 리딩하기에 충분히 구체적인 질문. message에는 질문을 따뜻하게 받아들이는 한두 문장을 씁니다.

[배열법 추천 — status와 무관하게 항상 채움]
- "one": 오늘의 운세, 간단하고 명확한 조언 하나
- "three": 시간에 따른 흐름(과거-현재-미래)이 궁금할 때
- "solution": 특정 문제의 원인과 해결책을 찾을 때(원인-현재-해결책)
- "celtic": 여러 요인이 얽힌 복합적인 문제, 깊은 심리 분석이 필요할 때(10장)

[공통]
- 모든 문장은 따뜻한 한국어 존댓말. message는 2~4문장.
- 타로는 생년월일·성별 같은 개인정보가 필요 없습니다. 묻지 마세요.
- suggestions가 필요 없으면 빈 배열로 둡니다.`;

const INTAKE_SCHEMA = {
  type: "OBJECT",
  properties: {
    status: { type: "STRING", enum: ["ok", "refine", "reframe", "blocked"] },
    topic: { type: "STRING", enum: ["none", "health", "legal", "finance", "crisis"] },
    message: { type: "STRING" },
    suggestions: { type: "ARRAY", items: { type: "STRING" } },
    category: { type: "STRING", enum: ["연애", "직업·학업", "금전", "인간관계", "자기성찰", "기타"] },
    spread: { type: "STRING", enum: ["one", "three", "solution", "celtic"] },
    spreadReason: { type: "STRING" },
  },
  required: ["status", "topic", "message", "suggestions", "category", "spread", "spreadReason"],
};

async function analyzeQuestion({ question, recent, reframed, signal }) {
  const history = recent.length
    ? recent.map((r) => `- ${r.daysAgo === 0 ? "오늘" : `${r.daysAgo}일 전`}: "${r.question}"` +
        (r.similarity ? ` (지금 질문과의 임베딩 유사도 ${r.similarity.toFixed(2)}${r.similar ? ", 높음" : ""})` : "") +
        (r.summary ? `\n  당시 결과 요약: ${r.summary}` : "")).join("\n")
    : "(없음)";

  const text = await generate({
    system: INTAKE_SYSTEM,
    json: INTAKE_SCHEMA,
    temperature: 0.4,
    signal,
    contents: [{
      role: "user",
      parts: [{ text: `[지금 질문]\n"${question}"\n\n[최근 리딩 기록]\n${history}` +
        (reframed ? "\n\n※ 이 질문은 앞서 제안된 역질문을 질문자가 선택한 것입니다. reframe으로 판단하지 마세요." : "") }],
    }],
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiError("질문을 살펴보는 중 응답 형식이 올바르지 않았어요. 다시 시도해주세요.");
  }
}

/* ---------- 3단계: 지식 베이스 (data/tarot-knowledge.json) ---------- */

let knowledgePromise = null;

// 한 번만 불러와 보관한다. 실패하면 null — 지식 베이스 없이도 리딩은 동작한다
function loadKnowledge() {
  if (!knowledgePromise) {
    knowledgePromise = fetch("data/tarot-knowledge.json")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return knowledgePromise;
}

// 질문 분야에 맞는 메이저 카드 해석 항목
const CATEGORY_FIELDS = {
  "연애": ["love", "advice"],
  "인간관계": ["love", "advice"],
  "직업·학업": ["career", "advice"],
  "금전": ["career", "advice"],
};
const FIELD_LABEL = { love: "연애", career: "직업/재정", advice: "심리 조언" };
const COURT_RANK_NAME = { 11: "Page", 12: "Knight", 13: "Queen", 14: "King" };

// 뽑힌 카드 한 장에 해당하는 지식만 꺼낸다
function cardKnowledge(kb, d, category) {
  const c = d.card;
  const k = kb?.cards?.[c.id];
  const dir = d.reversed ? "reversed" : "upright";
  const dirKo = d.reversed ? "역방향" : "정방향";
  if (!k) return [`그림 속 상징: ${c.symbols}`];

  if (c.major) {
    const fields = CATEGORY_FIELDS[category] || ["love", "career", "advice"];
    return [
      `심리학적 원형: ${k.archetype}${k.jung ? ` · 융 대응: ${k.jung}` : ""}`,
      `카발라 대응: 히브리 문자 ${k.hebrew}(${k.letterType}) · ${k.path}`,
      `도상 상징: ${k.symbols}`,
      `그림 장면: ${c.symbols}`,
      ...fields.map((f) => `${dirKo} 해석 — ${FIELD_LABEL[f]}: ${k[dir][f]}`),
    ];
  }
  const suit = kb.suits?.[c.suit];
  const lines = [`수트: ${c.ko.split(" ")[0]} — ${suit ? `${suit.element} 원소 · ${suit.function}` : ELEMENTS[c.element].ko}`];
  if (c.court) {
    const rank = kb.courtRanks?.[COURT_RANK_NAME[c.rank]];
    lines.push(`원소 조합: ${k.elementBlend} · 인물 원형: ${k.archetype}`);
    if (rank) lines.push(`계급의 의미: ${rank.meaning} (${rank.orientation}적 차원)`);
  } else {
    const num = kb.numerology?.[c.rank];
    lines.push(`세피라 · 점성 대응: ${k.sephira} / ${k.astrology}`);
    if (num) lines.push(`수비학: ${c.rank} — ${num.meaning}`);
  }
  lines.push(`그림 장면: ${c.symbols}`, `${dirKo} 핵심 해석: ${k[dir]}`);
  return lines;
}

/* ---------- 4단계: 리딩 생성 ---------- */

const READER_SYSTEM = `당신은 융 심리학 기반의 전문 타로 마스터이자, 공감 중심의 심리 분석가·상담가입니다.
타로는 미래를 맞히는 예언이 아니라, 상징 체계를 통해 질문자의 무의식과 삶의 서사를 비추는 심리역동적 거울이자 자기인식의 도구라는 관점을 따릅니다.

[해석 규칙]
1. 지식 베이스 우선: [배치된 카드 정보]에 제공된 원형·도상 상징·분야별 해석을 1차 근거로 삼고, 질문자의 고민에 맞게 재구성합니다.
   제공되지 않은 상징이나 대응(점성·카발라 등)을 지어내지 마세요.
2. 사전 나열식 설명 금지: 키워드나 대응 관계를 늘어놓지 말고, 고민에 직접 연결해 이야기하듯 풀어냅니다.
   카발라·점성 대응은 해석을 깊게 할 때만 한 구절로 녹여 쓰고, 전문 용어는 쉬운 말로 풀어줍니다.
3. 조합 문법 적용: [조합 해석 데이터]가 주어지면 반드시 반영합니다.
   주어-수식어 판별 → 카드 간 상호작용(강화·대립·한정·순차) → 수트 결합 → 숫자 반복 → 메이저 조합 공식 → 원소 위계 → 총합수 순서로 엮어,
   카드에서 카드로 이어지는 서사의 전환점을 짚습니다. 인물의 시선 방향은 그림 정보로 확실할 때만 언급합니다.
4. 단정적 예언 금지: "3개월 뒤 헤어집니다" 같은 단정 대신 가능성과 조언 중심으로 씁니다.
   미래·결과 자리는 고정된 결말이 아니라, 조언을 실천했을 때 향하게 될 흐름으로 서술합니다.
5. 역방향은 '나쁜 카드'가 아니라 내면화·저항·불균형·지연·교정 중 어떤 양상인지 짚어, 보지 못한 그림자를 통합하라는 신호로 해석합니다.
6. 코트 카드는 실제 인물일 수도, 질문자 내면의 한 측면(투사된 인물 원형)일 수도 있음을 열어 둡니다.

[대화 모드 — 리딩 후 추가 질문]
- 새 카드를 뽑지 않고, 이미 펼쳐진 카드 안에서 답합니다.
- 질문자가 같은 질문을 다른 답을 기대하며 반복하면, 지적하지 말고 감정을 먼저 알아준 뒤
  나의 행동·태도·심리로 주어를 바꾼 질문을 제안합니다.

[안전]
- 질병 진단·임신 여부 판정·약·치료 결정, 극단적 투자, 법적 소송 결과, 자해·생명과 관련된 판단은 하지 말고 의사·변호사·재무 전문가·상담센터를 안내합니다.
- 임신·출산·건강을 둘러싼 흐름과 마음은 해석해도 됩니다. 이때 "임신이 됩니다/안 됩니다" 같은 단정은 피하고,
  의학적인 부분은 전문의와 상의하도록 한 문장으로 부드럽게 덧붙입니다.
- 지식 베이스의 해석 중 '파산', '패소' 같은 강한 표현은 단정하지 말고 가능성과 경계의 언어로 순화합니다.
- 모든 답은 따뜻하지만 솔직한 한국어 존댓말로 씁니다.`;

const ELEMENT_OPPOSITES = [["fire", "water"], ["air", "earth"]];

// 카드 간 흐름 데이터 — 원소·수트·숫자·메이저 비중 등을 미리 계산해 LLM에 사실로 건넨다
function computeSynthesis(drawn) {
  const cards = drawn.map((d) => d.card);
  const lines = [];
  const majors = cards.filter((c) => c.major);
  lines.push(`메이저 아르카나 ${majors.length}장 / 전체 ${cards.length}장` +
    (majors.length * 2 >= cards.length && cards.length > 1 ? " → 개인의 선택을 넘어선 큰 흐름·인생의 전환점이 강조됨" : ""));

  const elemCount = { fire: 0, water: 0, air: 0, earth: 0 };
  cards.forEach((c) => { if (c.element) elemCount[c.element]++; });
  lines.push("원소 분포(메이저는 점성 대응 기준): " +
    Object.entries(elemCount).map(([k, v]) => `${ELEMENTS[k].ko} ${v}`).join(", "));
  const max = Math.max(...Object.values(elemCount));
  if (cards.length >= 3 && max >= 2) {
    const dom = Object.keys(elemCount).filter((k) => elemCount[k] === max);
    lines.push(`우세 원소: ${dom.map((k) => `${ELEMENTS[k].ko}(${ELEMENTS[k].func})`).join(", ")}`);
  }
  if (cards.length >= 4) {
    const missing = Object.keys(elemCount).filter((k) => elemCount[k] === 0);
    if (missing.length) lines.push(`빠진 원소: ${missing.map((k) => `${ELEMENTS[k].ko}(${ELEMENTS[k].func})`).join(", ")}`);
  }
  for (const [a, b] of ELEMENT_OPPOSITES) {
    if (elemCount[a] && elemCount[b]) lines.push(`원소 충돌: ${ELEMENTS[a].ko} · ${ELEMENTS[b].ko} 원소가 함께 나옴 → 상반된 힘 사이의 긴장`);
  }

  const suitCount = {};
  cards.filter((c) => !c.major).forEach((c) => { suitCount[c.suit] = (suitCount[c.suit] || 0) + 1; });
  const repeatedSuits = SUITS.filter((s) => suitCount[s.key] >= 2).map((s) => `${s.ko} ${suitCount[s.key]}장`);
  if (repeatedSuits.length) lines.push(`반복되는 수트: ${repeatedSuits.join(", ")}`);

  const courts = cards.filter((c) => c.court);
  if (courts.length) lines.push(`코트(인물) 카드 ${courts.length}장: ${courts.map((c) => c.ko).join(", ")}`);

  const rev = drawn.filter((d) => d.reversed).length;
  if (rev) lines.push(`역방향 ${rev}장 / ${drawn.length}장`);
  return lines.map((l) => `- ${l}`).join("\n");
}

function elementRelation(a, b) {
  if (a === b) return "same";
  const pair = [a, b].sort().join("+");
  return { "air+fire": "fire+air", "earth+water": "water+earth", "fire+water": "fire+water", "air+earth": "air+earth" }[pair] || "neutral";
}

// 원소 위계: 양옆 카드의 원소 조화도로 한 장의 품위(Well/Ill-dignified)를 판별
function dignityLines(kb, drawn, triples, pairs) {
  const ed = kb.elementalDignities;
  const name = (i) => `${i + 1}번 ${drawn[i].card.ko}`;
  const out = [];
  for (const [a, b] of pairs) {
    const rel = elementRelation(drawn[a].card.element, drawn[b].card.element);
    out.push(`${name(a)} ↔ ${name(b)}: ${ed[rel].label} — ${ed[rel].desc}`);
  }
  for (const [l, m, r] of triples) {
    const rels = [l, r].map((x) => elementRelation(drawn[m].card.element, drawn[x].card.element));
    const friendly = rels.filter((x) => x === "same" || x === "fire+air" || x === "water+earth").length;
    const enemy = rels.filter((x) => x === "fire+water" || x === "air+earth").length;
    const verdict = friendly && !enemy ? "긍정적 품위(Well-dignified): 카드의 힘이 건강하게 강화됨"
      : enemy && !friendly ? "부정적 품위(Ill-dignified): 카드의 힘이 약해지거나 왜곡됨"
      : friendly && enemy ? "혼합: 한쪽은 힘을 돋우고 한쪽은 견제함"
      : "중립: 양옆의 영향이 크지 않아 카드 본래의 의미대로 드러남";
    out.push(`${name(m)}은(는) 양옆(${name(l)}, ${name(r)}) 사이에서 ${verdict}`);
  }
  return out;
}

// 보고서의 조합 해석 규칙 중, 이번 리딩에 실제로 해당하는 것만 고른다
function combinationData(kb, drawn, spreadKey, category) {
  if (!kb || drawn.length < 2) return "";
  const cards = drawn.map((d) => d.card);
  const out = [];

  // 1) 주어-수식어
  const majors = cards.filter((c) => c.major);
  const minors = cards.filter((c) => !c.major);
  if (majors.length && minors.length) {
    out.push(`주어-수식어: 메이저(${majors.map((c) => c.ko).join(", ")})가 거시적 주제(주어), 마이너(${minors.map((c) => c.ko).join(", ")})가 그 주제가 일상에서 드러나는 구체적 방식(수식어)`);
  } else if (!majors.length) {
    const subjectSuit = { "연애": "cups", "인간관계": "cups", "금전": "pents", "직업·학업": "pents" }[category];
    const subj = subjectSuit && minors.filter((c) => c.suit === subjectSuit);
    if (subj?.length) out.push(`주어-수식어: 질문 분야와 맞닿은 ${subj.map((c) => c.ko).join(", ")}이(가) 주어, 나머지 카드는 이를 수식`);
  }

  // 2) 수트 결합 — 많이 나온 수트끼리의 결합을 우선해 최대 3쌍
  const suitCount = {};
  minors.forEach((c) => { suitCount[c.suit] = (suitCount[c.suit] || 0) + 1; });
  const suits = Object.keys(suitCount);
  const suitPairs = [];
  for (let i = 0; i < suits.length; i++) {
    for (let j = i + 1; j < suits.length; j++) {
      const sp = kb.suitPairs[[suits[i], suits[j]].sort().join("+")];
      if (sp) suitPairs.push({ sp, weight: suitCount[suits[i]] + suitCount[suits[j]] });
    }
  }
  suitPairs.sort((a, b) => b.weight - a.weight).slice(0, 3)
    .forEach(({ sp }) => out.push(`수트 결합 [${sp.type}] ${sp.theme}: ${sp.desc}`));

  // 3) 숫자·계급 반복
  const counts = {};
  minors.forEach((c) => {
    const key = c.court ? COURT_RANK_NAME[c.rank] : String(c.rank);
    counts[key] = (counts[key] || 0) + 1;
  });
  Object.entries(counts).filter(([, v]) => v >= 2).forEach(([key, v]) => {
    const text = kb.multiples[key]?.[Math.min(v, 4) - 2];
    if (text) out.push(`반복 증폭: ${key === String(Number(key)) ? `숫자 ${key}` : key} 카드 ${v}장 → ${text}`);
  });

  // 4) 메이저 조합 공식
  const nums = new Set(majors.map((c) => c.number));
  kb.majorPairs.filter((p) => p.cards.every((n) => nums.has(n))).forEach((p) => {
    out.push(`메이저 조합 공식 (${p.cards.map((n) => MAJOR_ARCANA[n][1]).join(" + ")}) — ${p.formula}: ${p.reading}`);
  });

  // 5) 원소 위계 (배열 구조에 따라 이웃 관계를 정한다)
  const n = drawn.length;
  let pairs = [], triples = [];
  if (spreadKey === "celtic") { pairs = [[0, 1]]; triples = [[6, 7, 8], [7, 8, 9]]; }
  else if (n === 3) { pairs = [[0, 1], [1, 2]]; triples = [[0, 1, 2]]; }
  else { for (let i = 0; i + 1 < n; i++) pairs.push([i, i + 1]); }
  out.push(...dignityLines(kb, drawn, triples, pairs).map((l) => `원소 위계: ${l}`));

  // 6) 총합수
  let sum = cards.reduce((s, c) => s + (c.major ? c.number : c.court ? c.rank - 10 : c.rank), 0);
  const raw = sum;
  while (sum > 21) sum = String(sum).split("").reduce((a, b) => a + Number(b), 0);
  const q = kb.cards[`major${String(sum).padStart(2, "0")}`];
  out.push(`총합수(Quintessence): 합계 ${raw} → ${sum}번 ${MAJOR_ARCANA[sum][1]}(${q?.archetype || ""}) — 표면적 사건 밑에 흐르는 기저 테마로 한 문장 언급`);

  return out.map((l) => `- ${l}`).join("\n");
}

/* ---------- 명확성 판단 & 보조 카드 ---------- */

// 그 자체로 "아직 정해지지 않음"을 뜻하는 카드
const UNDECIDED_CARDS = {
  major18: "달 — 안개 속의 불확실성",
  major10: "운명의 수레바퀴 — 아직 돌아가는 중인 흐름",
  major12: "매달린 사람 — 멈춤과 보류",
  swords02: "소드 2 — 결정 보류와 교착",
  cups07: "컵 7 — 넘치는 선택지와 환상",
};

// 핵심 자리(현재·결과 등)에 놓인 미정 카드를 미리 찾아 판단 근거로 건넨다
function undecidedSignals(spread, drawn) {
  return drawn
    .map((d, i) => ({ d, i, pos: spread.positions[i] }))
    .filter(({ d, pos }) => pos.key && UNDECIDED_CARDS[d.card.id])
    .map(({ d, i, pos }) => `${i + 1}번 "${pos.name}" 자리에 ${UNDECIDED_CARDS[d.card.id]}${d.reversed ? " (역방향: 안개가 걷히는 중일 수도 있음)" : ""}`);
}

function clarityGuide(spread, drawn) {
  const signals = undecidedSignals(spread, drawn);
  return `[명확성 판단]
해석을 마친 뒤, 이 배열이 질문에 얼마나 선명하게 답하는지 아래 순서로 판단합니다.
1. 핵심 자리에 '미정'을 뜻하는 카드가 있는가? → 있다면 undecided
2. 카드들이 하나의 이야기(인과·흐름)로 이어지는가? → 이어진다면 그 이야기가 망설임이나 상반된 흐름이어도 clear 또는 undecided
3. 해석이 막힌 곳이 특정 자리 하나에 몰려 있는가? (그 자리 카드가 질문과 연결되지 않음, 코트 카드의 주체를 알 수 없음 등) → clarify
4. 전체가 이어지지 않고 질문과도 동떨어졌는가? → 먼저 '지금 마음을 차지한 다른 문제'로 읽을 수 있는지 보고, 그래도 안 되면 clarify
- clear: 카드들이 질문에 선명하게 답함
- undecided: 애매함 자체가 메시지. 해석 본문에서 "아직 정해지지 않은 흐름이며 질문자의 선택이 방향을 정한다"는 점을 솔직하게 풀어줍니다.
- clarify: 정보가 비어 있는 자리가 있음. 보충이 필요한 자리 번호 하나와 짧은 이유를 적습니다. 남용하지 말고, 정말 막힌 경우에만 씁니다.
- 질문이 상대의 선택에 달린 것처럼 본질적으로 확정할 수 없는 성격이라면 clarify가 아니라 undecided입니다.
미정 신호(코드가 찾은 사실): ${signals.length ? signals.join("; ") : "없음"}`;
}

// 응답에서 [[CLARITY:...]] 판정을 떼어낸다
function parseClarity(text, cardCount) {
  const m = text.match(/\[\[CLARITY:\s*(clear|undecided|clarify)\s*(?::\s*(\d+))?\s*(?::\s*([^\]]*))?\]\]/i);
  const body = text.replace(/\[\[CLARITY:[^\]]*\]\]\s*/gi, "").trim();
  if (!m) return { body, clarity: { type: "clear" } };
  const type = m[1].toLowerCase();
  const pos = Number(m[2]);
  if (type === "clarify" && !(pos >= 1 && pos <= cardCount)) return { body, clarity: { type: "undecided" } };
  return { body, clarity: { type, pos: type === "clarify" ? pos - 1 : null, reason: (m[3] || "").trim() } };
}

function buildClarifierPrompt({ d, posIndex, spread, category, kb }) {
  const pos = spread.positions[posIndex];
  const c = d.card;
  const dir = d.reversed ? "역방향" : "정방향";
  return `[보조 카드]
${posIndex + 1}번 "${pos.name}" 자리가 선명하지 않아, 질문자가 남은 덱에서 보조 카드 한 장을 직접 골랐습니다.
보조 카드는 새로운 포지션이 아니라, 이 자리의 의미를 선명하게 비춰주는 용도입니다. 보조 카드는 이번 리딩에서 이 한 장뿐입니다.

카드: ${c.ko} (${c.en}), ${dir}
키워드: ${d.reversed ? c.rev : c.up}
${cardKnowledge(kb, d, category).join("\n")}

아래 형식으로 답해주세요. [[CARD]]와 [[CLARITY]] 표시는 쓰지 않습니다.

### 보조 카드 · ${c.ko} (${dir}) → ${pos.name} 보충
(보조 카드의 상징이 "${pos.name}" 자리의 모호함을 어떻게 풀어주는지, 원래 카드와 함께 읽어 3~4문장)

**더 선명해진 흐름:** (전체 리딩이 어떻게 달라지거나 분명해졌는지 1~2문장. 그래도 여전히 열려 있다면 그것을 솔직하게 말합니다)

[[SUGGEST]]
- (후속 질문 1)
- (후속 질문 2)`;
}

function buildReadingPrompt({ question, category, spread, spreadKey, drawn, kb }) {
  const cardBlocks = drawn.map((d, i) => {
    const c = d.card;
    const pos = spread.positions[i];
    const meta = c.major
      ? `메이저 ${c.number}번 · 점성 대응: ${c.astro} · 원소: ${ELEMENTS[c.element].ko}`
      : `마이너 · ${ELEMENTS[c.element].ko} 원소(${ELEMENTS[c.element].func})`;
    return `${i + 1}. [${pos.name} — ${pos.desc}]
   카드: ${c.ko} (${c.en}), ${d.reversed ? "역방향" : "정방향"}
   ${meta}
   키워드: ${d.reversed ? c.rev : c.up}
${cardKnowledge(kb, d, category).map((l) => `   ${l}`).join("\n")}`;
  }).join("\n\n");

  const combo = combinationData(kb, drawn, spreadKey, category);
  const hasReversed = drawn.some((d) => d.reversed);
  const reversalGuide = kb && hasReversed
    ? `\n\n[역방향 해석 모델]\n${kb.reversals.modes.map((m) => `- ${m.name}: ${m.desc}`).join("\n")}\n- ${kb.reversals.principle}`
    : "";
  const spreadGuide = kb?.spreads?.[spreadKey] ? `\n배열법 읽는 법: ${kb.spreads[spreadKey]}` : "";
  const grammarGuide = kb && drawn.length >= 2
    ? `\n\n[카드 간 상호작용 문법]\n${kb.grammar.dynamics.map((g) => `- ${g.name}: ${g.desc} (예: ${g.examples[0]})`).join("\n")}\n${kb.grammar.gaze.map((g) => `- 시선: ${g}`).join("\n")}`
    : "";

  const long = drawn.length >= 10;
  return `내담자의 고민: "${question}"
분야: ${category || "기타"}
배열법: ${spread.name} (${spread.desc})${spreadGuide}

[배치된 카드 정보]
${cardBlocks}

[카드 간 흐름 데이터]
${computeSynthesis(drawn)}${combo ? `\n\n[조합 해석 데이터]\n${combo}` : ""}${grammarGuide}${reversalGuide}

${clarityGuide(spread, drawn)}

아래 형식을 정확히 지켜 마크다운으로 답해주세요.
각 카드 해석은 반드시 [[CARD:번호]] 표시로 시작합니다 (번호는 위 목록 번호).

[[CARD:1]]
### (포지션) · (카드 한글 이름) (정/역방향)
(도상 상징과 이 자리의 의미를 고민에 연결 — ${long ? "2~3" : "3~5"}문장)

(카드 수만큼 반복)

## 카드가 그리는 흐름
(조합 해석 데이터와 서사의 전환점을 엮은 종합 해석 — 4~6문장)

## 조언
- (현실적인 행동 방향이나 마음가짐 2~3개)

> (질문자에게 건네는 짧은 한 줄 메시지)

[[CLARITY:clear]] 또는 [[CLARITY:undecided]] 또는 [[CLARITY:clarify:보충할 자리 번호:짧은 이유]] 중 하나

[[SUGGEST]]
- (질문자가 이어서 물어볼 만한 후속 질문 1 — 나의 행동·태도·심리를 주어로)
- (후속 질문 2)
- (후속 질문 3)`;
}

function buildFollowupPrompt(q) {
  return `추가 질문: ${q}

앞서 펼친 카드와 해석을 바탕으로 [[CARD]] 표시 없이 3~6문장으로 답해주세요.
답 끝에는 아래 형식으로 이어서 물어볼 만한 질문 2개를 붙여주세요.

[[SUGGEST]]
- (후속 질문 1)
- (후속 질문 2)`;
}

// 응답에서 [[SUGGEST]] 블록을 떼어낸다
function splitSuggestions(text) {
  const at = text.indexOf("[[SUGGEST]]");
  if (at < 0) return { body: text, suggestions: [] };
  const suggestions = text.slice(at + 11).split("\n")
    .map((l) => l.replace(/^\s*[-*•\d.)]+\s*/, "").trim())
    .filter(Boolean).slice(0, 3);
  return { body: text.slice(0, at).trim(), suggestions };
}
