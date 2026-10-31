// dashboard-issue.js - read-only probe for anti.browser.evaluate in an authenticated
// https://feedback.f1genz.dev/ tab (the dashboard sits behind Cloudflare Access; no HTTP access).
// USAGE: first run a separate evaluate that sets the stable issue id, e.g.
//     window.__PROBE_ID = "123"
//   then run this file's expression. The id is the stable `id` of originalFeedback items,
//   NOT the row number (row numbers shift when other rows move).
// MEASURES: the originalFeedback item with String(x.id) === ID: host, shop, link, stage,
//   deadline, tags, rowNumber, comment count and the first 160 chars of the last comment,
//   plus Object.keys(x) so the Leader can see which fields exist.
// DOES NOT PROVE: that the comment is visible to the customer, that quickUpdate persisted
//   server-side (reload the page and run this probe again), or who wrote the comment. The
//   comment field names are not verified against the dashboard source: the probe tries
//   x.comments (array), x.commentCount and x.comment_count, and reports `commentsSource` so
//   an unexpected shape is visible instead of silently reading as "0 comments".
(async () => {
  const ID = window.__PROBE_ID;
  if (ID === undefined || ID === null || String(ID) === "") {
    return { error: "set window.__PROBE_ID first (separate evaluate call)" };
  }
  for (let i = 0; i < 40 && !(typeof originalFeedback !== "undefined" && originalFeedback.length); i++) {
    await new Promise((r) => setTimeout(r, 300));
  }
  if (typeof originalFeedback === "undefined" || !originalFeedback.length) {
    return { error: "originalFeedback not loaded (Cloudflare Access login page, or the dashboard changed)" };
  }
  const x = originalFeedback.find((r) => String(r.id) === String(ID));
  if (!x) return { found: false, id: String(ID), total: originalFeedback.length };
  let comments = null;
  let commentsSource = null;
  if (Array.isArray(x.comments)) {
    comments = x.comments;
    commentsSource = "comments[]";
  }
  const countField = x.commentCount ?? x.comment_count ?? null;
  const last = comments && comments.length ? comments[comments.length - 1] : null;
  const lastText = last == null ? null : String(typeof last === "string" ? last : last.text ?? last.content ?? last.body ?? last.note ?? last.message ?? JSON.stringify(last)).slice(0, 160);
  return {
    found: true,
    id: String(x.id),
    rowNumber: x.rowNumber,
    host: x.host,
    shop: x.shop,
    link: x.link,
    stage: x.stage,
    deadline: x.deadline,
    tags: x.tags,
    commentCount: comments ? comments.length : countField,
    commentsSource: commentsSource ?? (countField !== null ? "commentCount" : "none-found"),
    lastCommentHead: lastText,
    keys: Object.keys(x),
  };
})()
