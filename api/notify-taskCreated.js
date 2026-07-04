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

    // 🔒 АТОМАРНЫЙ LOCK (главный фикс квоты + дублей)
    const lockOk = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();

      if (!snap.exists) return false;

      if (data?.notifyCreatedProcessed) return false;

      const created = data?.createdAt?.toDate?.();
      if (created) {
        const ageMs = Date.now() - created.getTime();
        if (ageMs > 24 * 60 * 60 * 1000) return false;
      }

      tx.update(ref, {
        notifyCreatedProcessed: true,
        notifyCreatedProcessingAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return true;
    });

    if (!lockOk) {
      return res.status(200).json({
        ok: true,
        skipped: "locked_or_too_old"
      });
    }

    const snap = await ref.get();
    const task = snap.data() || {};

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

    const result = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title: "Новая задача",
        body: task.title || "Без названия",
      },
      data: {
        taskId,
        type: "taskCreated",
      },
    });

    await ref.update({
      notifyCreatedSentAt: admin.firestore.FieldValue.serverTimestamp(),
      notifyCreatedSuccess: result.successCount,
      notifyCreatedFailed: result.failureCount,
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
