// Vercel 서버리스 함수 — Gemini API 프록시
// API 키는 Vercel 환경변수(GEMINI_API_KEY)에만 두고, 브라우저에는 절대 내려보내지 않는다.
//
// 환경변수
//   GEMINI_API_KEY  (필수) Google AI Studio에서 발급한 키
//   GEMINI_MODEL    (선택) 리딩용 모델, 기본 gemini-flash-latest
//   RATE_LIMIT      (선택) IP당 10분 동안 허용할 요청 수, 기본 40

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const EMBED_MODEL = "gemini-embedding-001";
const WINDOW_MS = 10 * 60 * 1000;
const MAX_BODY = 200 * 1024;

// 인스턴스 메모리 기반이라 완벽하진 않지만, 한 사람이 연타로 한도를 소진하는 것은 막는다
const hits = new Map();

function rateLimited(ip) {
  const limit = Number(process.env.RATE_LIMIT) || 40;
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > limit;
}

function sendError(res, status, message) {
  res.status(status).json({ error: { message } });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return sendError(res, 405, "POST만 지원해요.");

  const key = process.env.GEMINI_API_KEY;
  if (!key) return sendError(res, 500, "SERVER_KEY_MISSING");

  // 다른 사이트에서 이 프록시를 가져다 쓰지 못하게 같은 도메인 요청만 허용
  const origin = req.headers.origin;
  if (origin) {
    let host = "";
    try { host = new URL(origin).host; } catch { /* "null" 등 잘못된 출처 */ }
    if (host !== req.headers.host) return sendError(res, 403, "허용되지 않은 출처예요.");
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return sendError(res, 429, "RATE_LIMITED");

  const { method, payload } = req.body || {};
  if (!payload || !["generateContent", "embedContent"].includes(method)) {
    return sendError(res, 400, "잘못된 요청이에요.");
  }
  if (JSON.stringify(payload).length > MAX_BODY) return sendError(res, 413, "요청이 너무 커요.");

  const model = method === "embedContent" ? EMBED_MODEL : (process.env.GEMINI_MODEL || "gemini-flash-latest");
  try {
    const upstream = await fetch(`${API_BASE}/${encodeURIComponent(model)}:${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(payload),
    });
    const text = await upstream.text();
    res.status(upstream.status).setHeader("Content-Type", "application/json").send(text);
  } catch {
    sendError(res, 502, "Gemini 서버에 연결하지 못했어요.");
  }
};
