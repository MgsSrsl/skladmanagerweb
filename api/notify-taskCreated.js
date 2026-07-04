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

  return app;
}

async function getUsersTokens(db, assigneeIds = []) {
  const tokens = [];

  if (assigneeIds.length) {
    for (const uid of assigneeIds) {
      const snap = await db.collection("users").doc(uid).get();
      const u = snap.data() || {};
      if (Array.isArray(u.fcmTokens)) tokens.push(...u.fcmTokens);
    }
  } else {
    const qs = await db.collection("users").where("onPickup", "==", true).get();
    qs.forEach(doc => {
      const u = doc.data();
      if (Array.isArray(u.fcmTokens)) tokens.push(...u.fcmTokens);
    });
  }

  return [...new Set(tokens)];
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({ ok: true, stop: true });
    }

    initAdmin();
    const db = admin.firestore();

    const body = req.body || {};
    const taskId = String(body.taskId || "").trim();

    if (!taskId) {
      return res.status(200).json({ ok: true, ignored: "missing_taskId" });
    }

    const ref = db.collection("tasks").doc(taskId);

    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(200).json({ ok: true, ignored: "task_not_found" });
    }

    const task = snap.data() || {};

    // 🔒 антидубль (НО НЕ ЛОК ДО ОТПРАВКИ)
    if (task.notifyCreatedProcessed) {
      return res.status(200).json({
        ok: true,
        skipped: "already_processed"
      });
    }

    const created = task.createdAt?.toDate?.();
    if (created) {
      const ageMs = Date.now() - created.getTime();
      if (ageMs > 24 * 60 * 60 * 1000) {
        return res.status(200).json({
          ok: true,
          ignored: "task_too_old"
        });
      }
    }

    const assigneeIds =
      Array.isArray(body.assigneeIds)
        ? body.assigneeIds
        : String(body.assigneeIds || "")
            .split(",")
            .map(s => s.trim())
            .filter(Boolean);

    const tokens = await getUsersTokens(db, assigneeIds);

    if (!tokens.length) {
      return res.status(200).json({ ok: true, sent: 0 });
    }

    const message = {
      tokens,
      notification: {
        title: "Новая задача",
        body: task.title || "Без названия",
      },
      data: {
        taskId,
        type: "taskCreated",
      },
    };

    const result = await admin.messaging().sendEachForMulticast(message);

    // 🔥 теперь помечаем ТОЛЬКО после успешной отправки
    await ref.update({
      notifyCreatedProcessed: true,
      notifyCreatedSentAt: admin.firestore.FieldValue.serverTimestamp(),
      notifyCreatedSuccess: result.successCount,
    });

    return res.status(200).json({
      ok: true,
      sent: result.successCount,
      failed: result.failureCount,
    });

  } catch (e) {
    console.error(e);

    return res.status(200).json({
      ok: true,
      error: e.message
    });
  }
}
