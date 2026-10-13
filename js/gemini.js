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

/* ---------- 3·4단계: 지식 베이스 주입 & 리딩 생성 ---------- */

const READER_SYSTEM = `당신은 융 심리학 기반의 전문 타로 마스터이자, 공감 중심의 심리 분석가·상담가입니다.
타로는 미래를 맞히는 예언이 아니라, 상징 체계를 통해 질문자의 무의식과 현재 상황의 흐름을 언어화하는 도구라는 관점을 따릅니다.

[해석 규칙]
1. 사전 나열식 설명 금지: 키워드를 늘어놓지 말고, 질문자의 고민에 직접 연결해 이야기하듯 해석합니다.
2. 포지션과 카드 상징을 1:1로 결합: 제공된 [그림 속 상징]을 근거로, 그 상징이 이 자리에서 무엇을 뜻하는지 설명합니다.
   제공되지 않은 상징을 지어내지 마세요. 역방향 카드는 그림이 거꾸로 놓였다는 점을 고려합니다.
3. 카드 간 상호작용(Synthesis) 필수: 제공된 [카드 간 흐름 데이터](원소 분포, 수트 반복, 메이저 비중, 숫자 반복, 원소 충돌 등)를 반드시 반영하고,
   카드에서 카드로 이어지는 서사의 전환점을 짚습니다. 인물의 시선 방향(왼쪽=과거·내면, 오른쪽=미래·외부)은 그림 정보로 확실할 때만 언급합니다.
4. 단정적 예언 금지: "3개월 뒤 헤어집니다" 같은 단정 대신 가능성과 조언 중심으로 씁니다.
   미래·결과 자리는 고정된 결말이 아니라, 조언을 실천했을 때 향하게 될 흐름으로 서술합니다.
5. 역방향은 '나쁜 카드'가 아니라 에너지의 막힘·지연·내면화로 균형 있게 해석합니다.
6. 코트 카드(페이지·나이트·퀸·킹)는 실제 인물일 수도, 질문자 내면의 한 측면일 수도 있음을 열어 둡니다.

[대화 모드 — 리딩 후 추가 질문]
- 새 카드를 뽑지 않고, 이미 펼쳐진 카드 안에서 답합니다.
- 질문자가 같은 질문을 다른 답을 기대하며 반복하면, 지적하지 말고 감정을 먼저 알아준 뒤
  나의 행동·태도·심리로 주어를 바꾼 질문을 제안합니다.

[안전]
- 질병 진단·임신 여부 판정·약·치료 결정, 극단적 투자, 법적 소송 결과, 자해·생명과 관련된 판단은 하지 말고 의사·변호사·재무 전문가·상담센터를 안내합니다.
- 임신·출산·건강을 둘러싼 흐름과 마음은 해석해도 됩니다. 이때 "임신이 됩니다/안 됩니다" 같은 단정은 피하고,
  의학적인 부분은 전문의와 상의하도록 한 문장으로 부드럽게 덧붙입니다.
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

  const numCount = {};
  cards.filter((c) => !c.major && !c.court).forEach((c) => { numCount[c.rank] = (numCount[c.rank] || 0) + 1; });
  const repeatedNums = Object.entries(numCount).filter(([, v]) => v >= 2);
  repeatedNums.forEach(([n, v]) => lines.push(`숫자 반복: 숫자 ${n} 카드 ${v}장 → ${RANKS[n - 1][2]}의 주제가 강조됨`));

  const courts = cards.filter((c) => c.court);
  if (courts.length) lines.push(`코트(인물) 카드 ${courts.length}장: ${courts.map((c) => c.ko).join(", ")}`);

  const rev = drawn.filter((d) => d.reversed).length;
  if (rev) lines.push(`역방향 ${rev}장 / ${drawn.length}장`);
  return lines.map((l) => `- ${l}`).join("\n");
}

function buildReadingPrompt({ question, category, spread, drawn }) {
  const cardBlocks = drawn.map((d, i) => {
    const c = d.card;
    const pos = spread.positions[i];
    const meta = c.major
      ? `메이저 ${c.number}번 · 점성 대응: ${c.astro} · 원소: ${ELEMENTS[c.element].ko}`
      : `마이너 · ${ELEMENTS[c.element].ko} 원소(${ELEMENTS[c.element].func}) · 수비학: ${c.numerology}`;
    return `${i + 1}. [${pos.name} — ${pos.desc}]
   카드: ${c.ko} (${c.en}), ${d.reversed ? "역방향" : "정방향"}
   ${meta}
   키워드: ${d.reversed ? c.rev : c.up}
   그림 속 상징: ${c.symbols}`;
  }).join("\n\n");

  const long = drawn.length >= 10;
  return `내담자의 고민: "${question}"
분야: ${category || "기타"}
배열법: ${spread.name} (${spread.desc})

[배치된 카드 정보]
${cardBlocks}

[카드 간 흐름 데이터]
${computeSynthesis(drawn)}

아래 형식을 정확히 지켜 마크다운으로 답해주세요.
각 카드 해석은 반드시 [[CARD:번호]] 표시로 시작합니다 (번호는 위 목록 번호).

[[CARD:1]]
### (포지션) · (카드 한글 이름) (정/역방향)
(그림 속 상징과 이 자리의 의미를 고민에 연결 — ${long ? "2~3" : "3~5"}문장)

(카드 수만큼 반복)

## 카드가 그리는 흐름
(카드 간 흐름 데이터와 서사의 전환점을 엮은 종합 해석 — 4~6문장)

## 조언
- (현실적인 행동 방향이나 마음가짐 2~3개)

> (질문자에게 건네는 짧은 한 줄 메시지)

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
