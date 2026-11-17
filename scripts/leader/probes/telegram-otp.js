// telegram-otp.js - read-only probe for anti.browser.evaluate in an own Telegram Web tab (https://web.telegram.org/k/)
//   with the "Group Feedback" topic Feedback open. Says whether a fresh Haravan OTP message is there WITHOUT returning
//   a single digit of the code: {topicOpen, newest:{ageSec,len,fromHaravan}|null, count, newerThanSend?}.
// USAGE: `LJ probe --name telegram-otp [--after <epochMs of the login/send click>]`, then pass the expression unchanged to
//   anti.browser.evaluate. It returns at once (NO waiting inside): evaluate is cut at 15 s with CAPABILITY_ERROR (measured
//   13/11/2026, an 80 s wait loop died), so poll from outside every 3-10 s with anti.browser.wait {condition:"timeout"}
//   and call it again. newerThanSend is true when the newest message's own "Lúc: HH:MM:SS DD/MM/YYYY" (GMT+7) is
//   >= after - 5 s; it is absent without --after.
// MEASURES: messages of the form "MÃ XÁC THỰC / Bấm để copy: ###### / Từ: <sender> / Lúc: ..." in the open chat.
//   len = length of the code (6 expected); fromHaravan = the "Từ:" line names noreply@haravan.com.
// DOES NOT PROVE: that the code belongs to YOUR login (another login in the same minute sends one too), that the
//   topic is Feedback rather than another one (check the URL thread yourself), or that the code is still valid.
// TAB: activate the Telegram tab (tabs.activate) and reload its view before trusting "count 0": a tab opened with
//   activate:false stayed frozen for ~110 s while the code had arrived (13/11/2026). The bubble selectors
//   (.bubbles-inner .bubble) are Telegram Web K's and were NOT verified against a live chat in this session.
(() => {
  const AFTER = typeof window.__PROBE_AFTER === "number" ? window.__PROBE_AFTER : null;
  const bubbles = [...document.querySelectorAll(".bubbles-inner .bubble, .bubble[data-mid]")];
  const seen = new Set();
  const msgs = [];
  for (const b of bubbles) {
    if (seen.has(b)) continue;
    seen.add(b);
    const t = b.innerText || "";
    if (!/MÃ XÁC THỰC/i.test(t)) continue;
    const code = /Bấm để copy:\s*(\d{4,10})/i.exec(t);
    const luc = /Lúc:\s*(\d{1,2}):(\d{2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
    const at = luc ? Date.UTC(+luc[6], +luc[5] - 1, +luc[4], +luc[1] - 7, +luc[2], +luc[3]) : null;
    msgs.push({ at, len: code ? code[1].length : 0, fromHaravan: /noreply@haravan\.com/i.test(t) });
  }
  msgs.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const last = msgs.at(-1) ?? null;
  const out = {
    topicOpen: bubbles.length > 0,
    newest: last ? { ageSec: last.at === null ? null : Math.max(0, Math.round((Date.now() - last.at) / 1000)), len: last.len, fromHaravan: last.fromHaravan } : null,
    count: msgs.length,
  };
  if (AFTER !== null) out.newerThanSend = !!last && last.at !== null && last.at >= AFTER - 5000;
  return out;
})()
