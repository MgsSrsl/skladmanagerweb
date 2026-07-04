// /api/notify-taskCreated.js
// ESM, package.json: { "type": "module" }

import admin from "firebase-admin";

let app;

function initAdmin() {
  if (app) return app;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT");

  const sa = JSON.parse(raw);
  sa.private_key = String(sa.private_key || "")
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .trim();

  app = admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: sa.project_id,
  });

  console.log("✅ Firebase initialized:", sa.project_id);
  return app;
}

function getHeader(req, name) {
  const key = name.toLowerCase();
  const value = req.headers?.[key] || req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseAllowedOrigins() {
  return String(process.env.NOTIFY_ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function setCors(req, res) {
  const origin = String(getHeader(req, "origin") || "").trim();
  const allowed = parseAllowedOrigins();

  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-notify-secret");
  res.setHeader("Cache-Control", "no-store");
}

function isAllowedRequest(req) {
  // 1) Разрешаем по секрету, если он есть
  const expectedSecret = String(process.env.NOTIFY_SECRET || "").trim();
  const gotSecret = String(getHeader(req, "x-notify-secret") || "").trim();

  if (expectedSecret && gotSecret && expectedSecret === gotSecret) {
    return true;
  }

  // 2) Разрешаем по Origin/Referer от твоей web-страницы
  const allowedOrigins = parseAllowedOrigins();

  if (!allowedOrigins.length) {
    console.log("⚠️ NOTIFY_ALLOWED_ORIGINS is empty");
    return false;
  }

  const origin = String(getHeader(req, "origin") || "").trim();
  const referer = String(getHeader(req, "referer") || "").trim();

  if (origin && allowedOrigins.includes(origin)) {
    return true;
  }

  if (referer) {
    for (const allowed of allowedOrigins) {
      if (referer.startsWith(allowed)) {
        return true;
      }
    }
  }

  return false;
}

async function parseBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  let raw = "";

  if (typeof req.body === "string") {
    raw = req.body;
  } else {
    raw = await new Promise((resolve, reject) => {
      let data = "";

      req.on("data", chunk => {
        data += chunk;
      });

      req.on("end", () => resolve(data));
      req.on("error", reject);
    }).catch(() => "");
  }

  raw = String(raw || "").trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (_) {
    // form-urlencoded
    const params = new URLSearchParams(raw);
    const obj = {};

    for (const [key, value] of params.entries()) {
      obj[key] = value;
    }

    return obj;
  }
}

function parseIds(value) {
  if (Array.isArray(value)) {
    return value.map(String).map(s => s.trim()).filter(Boolean);
  }

  return String(value || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function normRole(role) {
  const s = String(role || "").toLowerCase().trim();

  if (["кладовщик", "кладовщица", "storekeeper", "kladovshik", "кладовщик склада"].includes(s)) {
    return "storekeeper";
  }

  if (["начальник", "head", "boss"].includes(s)) {
    return "head";
  }

  if (["менеджер", "manager"].includes(s)) {
    return "manager";
  }

  return s;
}

async function createLock(db, taskId) {
  const lockId = `taskCreated_${taskId}`;
  const ref = db.collection("_notifyLocks").doc(lockId);

  try {
    await ref.create({
      taskId,
      type: "taskCreated",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return true;
  } catch (e) {
    const code = String(e.code || "");
    const msg = String(e.message || "").toLowerCase();

    if (
      code === "6" ||
      code === "already-exists" ||
      msg.includes("already exists")
    ) {
      return false;
    }

    throw e;
  }
}

async function getUserById(db, uid) {
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) return null;
  return { id: uid, ...(snap.data() || {}) };
}

async function collectTokens(db, assigneeIds, authorUid) {
  let tokens = [];
  const picked = [];

  if (assigneeIds.length) {
    for (const uid of assigneeIds) {
      const u = await getUserById(db, uid);
      if (!u) continue;

      const list = Array.isArray(u.fcmTokens) ? u.fcmTokens.filter(Boolean) : [];

      picked.push({
        uid,
        role: u.role || "",
        tokenCount: list.length,
      });

      tokens.push(...list);
    }
  } else {
    const qs = await db.collection("users").where("onPickup", "==", true).get();

    qs.forEach(doc => {
      const u = doc.data() || {};
      const role = normRole(u.role);

      if (role !== "storekeeper" && role !== "head") return;

      const list = Array.isArray(u.fcmTokens) ? u.fcmTokens.filter(Boolean) : [];

      picked.push({
        uid: doc.id,
        role: u.role || "",
        onPickup: true,
        tokenCount: list.length,
      });

      tokens.push(...list);
    });
  }

  tokens = [...new Set(tokens)].filter(Boolean);

  // Не шлём автору, если у него есть токены
  if (authorUid) {
    const author = await getUserById(db, authorUid);

    if (author) {
      const authorTokens = new Set(
        Array.isArray(author.fcmTokens)
          ? author.fcmTokens.filter(Boolean)
          : []
      );

      tokens = tokens.filter(t => !authorTokens.has(t));
    }
  }

  console.log("👥 picked users:", picked.length, "🎫 tokens:", tokens.length);

  return tokens;
}

async function sendMulticast(tokens, message) {
  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);

    const result = await admin.messaging().sendEachForMulticast({
      tokens: chunk,
      ...message,
    });

    successCount += result.successCount;
    failureCount += result.failureCount;
  }

  return { successCount, failureCount };
}

export default async function handler(req, res) {
  try {
    setCors(req, res);

    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    // Старым клиентам не отдаём ошибку, чтобы они не ретраили.
    if (req.method !== "POST") {
      return res.status(200).json({
        ok: true,
        sent: 0,
        ignored: true,
        reason: "not_post"
      });
    }

    /**
     * САМОЕ ВАЖНОЕ:
     * сначала отсечка старых клиентов.
     * До этого места Firebase НЕ инициализируется и НЕ читает Firestore.
     */
    if (!isAllowedRequest(req)) {
      console.log("🚫 notify-taskCreated ignored before Firebase: not allowed");

      return res.status(200).json({
        ok: true,
        sent: 0,
        ignored: true,
        reason: "not_allowed"
      });
    }

    const body = await parseBody(req);

    const taskId = String(body.taskId || "").trim();

    if (!taskId) {
      return res.status(200).json({
        ok: true,
        sent: 0,
        ignored: true,
        reason: "missing_taskId"
      });
    }

    initAdmin();
    const db = admin.firestore();

    /**
     * Антидубль ДО чтения задачи.
     * Если нормальный клиент случайно отправит 10 раз,
     * только первый раз дойдёт до чтения tasks/{taskId}.
     */
    const firstTime = await createLock(db, taskId);

    if (!firstTime) {
      return res.status(200).json({
        ok: true,
        sent: 0,
        duplicate: true,
        reason: "already_processed"
      });
    }

    const taskRef = db.collection("tasks").doc(taskId);
    const snap = await taskRef.get();

    if (!snap.exists) {
      return res.status(200).json({
        ok: true,
        sent: 0,
        ignored: true,
        reason: "task_not_found"
      });
    }

    const task = snap.data() || {};

    // Не шлём пуши по очень старым задачам
    const created = task.createdAt?.toDate?.();

    if (created) {
      const ageMs = Date.now() - created.getTime();

      if (ageMs > 24 * 60 * 60 * 1000) {
        return res.status(200).json({
          ok: true,
          sent: 0,
          ignored: true,
          reason: "task_too_old"
        });
      }
    }

    let assigneeIds = parseIds(body.assigneeIds);

    // Если с web-страницы исполнители не пришли — берём из задачи
    if (!assigneeIds.length) {
      if (Array.isArray(task.assignees)) {
        assigneeIds = task.assignees.filter(Boolean);
      } else if (Array.isArray(task.assigneeIds)) {
        assigneeIds = task.assigneeIds.filter(Boolean);
      }
    }

    const authorUid = task.creatorId || task.authorUid || task.createdBy || "";

    console.log("🧾 notify taskCreated:", {
      taskId,
      assigneesCount: assigneeIds.length,
      authorUid,
    });

    const tokens = await collectTokens(db, assigneeIds, authorUid);

    if (!tokens.length) {
      await taskRef.update({
        notifyCreatedProcessed: true,
        notifyCreatedSentAt: admin.firestore.FieldValue.serverTimestamp(),
        notifyCreatedSuccess: 0,
        notifyCreatedFailed: 0,
        notifyCreatedReason: "no_tokens",
      });

      return res.status(200).json({
        ok: true,
        sent: 0,
        reason: "no_tokens"
      });
    }

    const title = task.title ? String(task.title) : "Новая задача";

    const pushBody =
      task.comment
        ? String(task.comment)
        : "Новое задание";

    /**
     * data-only, как в твоём старом рабочем варианте.
     * Android сам показывает уведомление и открывает задачу по taskId.
     */
    const message = {
      android: {
        priority: "high",
        ttl: 24 * 60 * 60,
      },
      data: {
        type: "taskCreated",
        taskId: String(taskId),
        title,
        body: pushBody,
      },
    };

    const result = await sendMulticast(tokens, message);

    await taskRef.update({
      notifyCreatedProcessed: true,
      notifyCreatedSentAt: admin.firestore.FieldValue.serverTimestamp(),
      notifyCreatedSuccess: result.successCount,
      notifyCreatedFailed: result.failureCount,
    });

    console.log("📨 notify sent:", {
      taskId,
      sent: result.successCount,
      failed: result.failureCount,
      tried: tokens.length,
    });

    return res.status(200).json({
      ok: true,
      sent: result.successCount,
      failed: result.failureCount,
      tokensTried: tokens.length,
    });

  } catch (e) {
    console.error("🔥 notify-taskCreated error:", e);

    // Не отдаём 500, чтобы клиенты не ретраили бесконечно.
    return res.status(200).json({
      ok: true,
      sent: 0,
      ignored: true,
      error: String(e.message || e),
    });
  }
}
