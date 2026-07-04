import admin from "firebase-admin";

let app;

function initAdmin() {
  if (app) return app;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT");

  const sa = JSON.parse(raw);
  sa.private_key = sa.private_key.replace(/\\n/g, "\n").trim();

  app = admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: sa.project_id,
  });

  console.log("✅ Firebase initialized");
  return app;
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";

    req.on("data", chunk => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function getUsersTokens(db, assigneeIds = []) {
  const tokens = [];

  if (assigneeIds.length) {
    for (const uid of assigneeIds) {
      const snap = await db.collection("users").doc(uid).get();
      const u = snap.data() || {};
      if (Array.isArray(u.fcmTokens)) {
        tokens.push(...u.fcmTokens);
      }
    }
  } else {
    const qs = await db.collection("users").where("onPickup", "==", true).get();

    qs.forEach(doc => {
      const u = doc.data();
      if (Array.isArray(u.fcmTokens)) {
        tokens.push(...u.fcmTokens);
      }
    });
  }

  return [...new Set(tokens)];
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    initAdmin();
    const db = admin.firestore();

    const body = await getBody(req);

    const taskId = String(body.taskId || "").trim();
    if (!taskId) {
      return res.status(400).json({ ok: false, error: "taskId required" });
    }

    let assigneeIds = [];
    if (typeof body.assigneeIds === "string") {
      assigneeIds = body.assigneeIds.split(",").map(s => s.trim()).filter(Boolean);
    } else if (Array.isArray(body.assigneeIds)) {
      assigneeIds = body.assigneeIds;
    }

    const taskSnap = await db.collection("tasks").doc(taskId).get();
    if (!taskSnap.exists) {
      return res.status(404).json({ ok: false, error: "task not found" });
    }

    const task = taskSnap.data();
    // не отправляем уведомления по задачам старше суток
const created = task.createdAt?.toDate?.();

if (created) {
  const ageHours = (Date.now() - created.getTime()) / 3600000;

  if (ageHours > 24) {
    console.log("Skip old task:", taskId);

    return res.json({
      ok: true,
      ignored: "task_too_old"
    });
  }
}

    const tokens = await getUsersTokens(db, assigneeIds);

    if (!tokens.length) {
      return res.json({ ok: true, sent: 0 });
    }

    const message = {
      tokens,
      notification: {
        title: "Новая задача",
        body: task.title || "Без названия",
      },
      data: {
        taskId: String(taskId),
        type: "taskCreated",
      },
    };

    const result = await admin.messaging().sendEachForMulticast(message);

    return res.json({
      ok: true,
      sent: result.successCount,
      failed: result.failureCount,
    });

  } catch (e) {
  console.error("notify-taskCreated error:", e);

  if (
    String(e.message).includes("RESOURCE_EXHAUSTED") ||
    String(e.details || "").includes("Quota exceeded")
  ) {
    console.log("Firestore quota exceeded -> return OK");

    return res.json({
      ok: true,
      ignored: "quota_exceeded"
    });
  }

  return res.status(500).json({
    ok: false,
    error: e.message
  });
}
