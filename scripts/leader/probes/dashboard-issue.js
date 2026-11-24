// dashboard-issue.js - read-only probe for anti.browser.evaluate in an authenticated
// https://feedback.f1genz.dev/ tab (the dashboard sits behind Cloudflare Access; no HTTP access).
// USAGE: first run a separate evaluate that sets the stable issue id, e.g.
//     window.__PROBE_ID = "123"
//   then run this file's expression. The id is the stable `id` of originalFeedback items,
//   NOT the row number (row numbers shift when other rows move).
// MEASURES: the originalFeedback item with String(x.id) === ID: host, shop, link, stage,
//   deadline, tags, rowNumber, comment count and the first 160 chars of the last comment,
//   plus Object.keys(x) so the Leader can see which fields exist.
// COMMENTS: the dashboard list rows carry no comments array; they are read with the dashboard's own
//   POST /api/getComments {rowNumber} (apiPost("getComments", ...), the call viewDetail makes; read-only), so
//   commentsSource is "getComments" and commentCount is the real count. "none-found" means NOTHING was read:
//   `leader-job.mjs record --kind dashboard` refuses PASS|WARN on such a probe.
// DOES NOT PROVE: that the comment is visible to the customer, that quickUpdate persisted
//   server-side (reload the page and run this probe again), or who wrote the comment. A comment
//   shape other than {text, time, author} still shows up in lastCommentHead as JSON.
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
  } else if (typeof apiPost === "function" && x.rowNumber !== undefined && x.rowNumber !== null) {
    try {
      const r = await apiPost("getComments", { rowNumber: x.rowNumber });
      if (r && r.success === true && Array.isArray(r.comments)) {
        comments = r.comments;
        commentsSource = "getComments";
      }
    } catch (e) {
      comments = null;
    }
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
    devNote: typeof x.devNote === "string" ? x.devNote.slice(0, 160) : null,
    commentCount: comments ? comments.length : countField,
    commentsSource: commentsSource ?? (countField !== null ? "commentCount" : "none-found"),
    lastCommentHead: lastText,
    lastCommentAuthor: last && typeof last === "object" ? (last.author ?? null) : null,
    keys: Object.keys(x),
  };
})()
