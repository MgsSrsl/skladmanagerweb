// /api/notify-taskCreated.js  (ESM)
export const config = { runtime: "edge" }; // можно edge/fun, на ваш вкус

export default async function handler(req) {
  try {
    const { taskId, assigneeIds } = await req.json();

    // Если потребуется секрет:
    const secret = process.env.NOTIFY_SECRET || "";
    const upstream = process.env.NOTIFY_URL || "https://skladsborka-notify.vercel.app/api/notify-taskCreated";

    const r = await fetch(upstream, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(secret ? { "x-secret": secret } : {}) },
      body: JSON.stringify({ taskId, assigneeIds })
    });

    const text = await r.text();
    return new Response(text, { status: r.status, headers: { "content-type": "application/json; charset=utf-8" }});
  } catch (e) {
    return new Response(JSON.stringify({ ok:false, error: String(e) }), { status: 500 });
  }
}
