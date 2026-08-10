import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { webpush } from "https://esm.sh/web-push";

interface PushSubscription {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface Notification {
  id: string;
  user_id: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sent_push: boolean;
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY") || "";
const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY") || "";
const contact = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@pacepack.app";

webpush.setVapidDetails(contact, vapidPublic, vapidPrivate);

Deno.serve(async (req) => {
  // Only allow cron / authenticated calls
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${Deno.env.get("CRON_SECRET")}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  // 1. Fetch unsent notifications (batch of 100)
  const { data: notifications, error: notifErr } = await supabase
    .from("notifications")
    .select("id, user_id, title, body, data, sent_push")
    .eq("sent_push", false)
    .limit(100);

  if (notifErr) {
    console.error("fetch notifications:", notifErr);
    return new Response("DB error", { status: 500 });
  }
  if (!notifications || notifications.length === 0) {
    return new Response("No notifications to send", { status: 200 });
  }

  // 2. Get all push subscriptions for the affected users
  const userIds = [...new Set(notifications.map((n) => n.user_id))];
  const { data: subs, error: subsErr } = await supabase
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth")
    .in("user_id", userIds);

  if (subsErr) {
    console.error("fetch subscriptions:", subsErr);
    return new Response("DB error", { status: 500 });
  }

  const subscriptions: PushSubscription[] = subs || [];
  const byUser = new Map<string, PushSubscription[]>();
  for (const sub of subscriptions) {
    const list = byUser.get(sub.user_id) || [];
    list.push(sub);
    byUser.set(sub.user_id, list);
  }

  let sent = 0;
  let failed = 0;
  const invalidSubs: string[] = [];

  // 3. Send push for each notification
  for (const notif of notifications as Notification[]) {
    const userSubs = byUser.get(notif.user_id) || [];
    if (!userSubs.length) {
      // No subscription — mark as sent so we don't retry forever
      await supabase.from("notifications").update({ sent_push: true }).eq("id", notif.id);
      sent++;
      continue;
    }

    const payload = JSON.stringify({
      title: notif.title,
      body: notif.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-72.png",
      data: notif.data || {},
      tag: `pp-${notif.id}`,
      renotify: true,
      vibrate: [200, 100, 200],
    });

    for (const sub of userSubs) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload
        );
        sent++;
      } catch (err) {
        failed++;
        const statusCode = (err as { statusCode?: number }).statusCode;
        // 404 / 410 — subscription expired/deleted, remove it
        if (statusCode === 404 || statusCode === 410) {
          invalidSubs.push(sub.id);
        } else {
          console.error("push error for sub", sub.id, err);
        }
      }
    }

    await supabase.from("notifications").update({ sent_push: true }).eq("id", notif.id);
  }

  // 4. Clean up invalid subscriptions
  if (invalidSubs.length) {
    await supabase.from("push_subscriptions").delete().in("id", invalidSubs);
  }

  return new Response(
    JSON.stringify({ sent, failed, cleaned: invalidSubs.length }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});