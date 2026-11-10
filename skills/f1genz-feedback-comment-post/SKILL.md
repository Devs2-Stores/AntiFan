---
name: f1genz-feedback-comment-post
description: Use to post a resolution note on a F1GENZ feedback dashboard issue (feedback.f1genz.dev). Issues with no linked Google Sheet always get the note as a dashboard comment. Posts through an AntiFan session-affiliated tab.
---

# Post resolution note on F1GENZ feedback issue

## 0. Where the note goes (decide first)
- If the issue links a customer Google Sheet (its Link or Nội dung has a docs.google.com/spreadsheets URL, or it says "như file"/"theo sheet"), the note goes in that sheet row (Dev note column + Stage). Use the sheet-writing skill (`google-sheet-feedback-row-marking`). Don't duplicate it here unless the user asks.
- If the issue has **no sheet**, post the note as a **comment** on the dashboard issue (the "Viết bình luận" box in the Chi tiết Feedback modal), using the steps below. Do not edit the Nội dung field to hold the note.

## Note format (user preference)
- Vietnamese with diacritics, short: 2-4 lines total. First line is `Em đã fix ạ:`, then `- ` bullets.
- Say where the merchant finds and uses it (e.g. the settings group name in Thiết lập theme) and current values if relevant.
- No internal file paths, no QA jargon. NEVER write "Cần đồng bộ theme" or ask the merchant to sync; syncing is the dev's job.
- Post one note per fix. Before posting, check the issue doesn't already have the same first line.
- A note that asks the customer something (Stage Pending) starts with `Em cần anh/chị xác nhận thêm ạ:`; a check that found nothing to change starts with `Em kiểm tra thì đã đúng ạ:`.
- One current dev note per issue: a new note that answers or supersedes an earlier dev note replaces it (see "Replacing an earlier dev note"). Two dev notes on one issue confuse QA.

## Steps
1. Pick a tab the session may drive: `anti.browser.tabs.list` (no args), then use an `affiliated:true` row, or rebind with `anti.browser.rebind_target`. You cannot use user-opened tabs (TARGET_MISMATCH) or stale bound tabs (TARGET_STALE); do not retry them. Partition persist:profile-profile-2 has already passed Cloudflare Access. Playwright cannot post because it hits the Access login wall.
2. Navigate to `https://feedback.f1genz.dev/?feedback=<N>`. The modal loads async: poll up to ~10s until `#newCommentText` exists. Confirm `#editRowNumber` == N, `#editShop` and `#editLink` match the job, and `button[onclick='addNewComment()']` exists.
3. Optional screenshots: save each as a JPEG of about 60-70KB. Then, one `anti.browser.evaluate` per image, run `currentCommentImages.push('data:image/jpeg;base64,<b64>'); renderCommentImagePreview();`. Don't simulate a clipboard paste. Evidence for a performance issue is the PSI score panel, not storefront renders.
4. Fill the text: `t=document.getElementById('newCommentText'); t.focus(); t.value=NOTE; t.dispatchEvent(new Event('input',{bubbles:true}))`.
5. Refresh the generation with `anti.inspect.snapshot` on `#newCommentText` (an empty CDATA snapshot is fine). Then click the send button with `anti.browser.evaluate`: `document.querySelector("button[onclick='addNewComment()']").click()`. Do not use `anti.agent.cursor.click` here: on a tab reporting `attached:false, active:false` it returned `clicked:true` four times (selector, x/y, after `tabs.activate`) but delivered no click event and posted nothing; check for the `addComment` POST or the textarea length before retrying. The button uploads the images to images.f1genz.dev and appends the `[IMAGE]url` lines itself.
6. After ~6s, verify that the textarea length is 0, `currentCommentImages.length` is 0, and `document.body.innerText` contains the note. Then confirm the note persisted: navigate to `?feedback=<N>&x=<random>`, poll, and check the note appears exactly once under a fresh timestamp. Posting and deleting a comment do not change the issue's `updatedAt`, so `updatedAt` is not evidence of either.
7. Do NOT change Stage, Deadline, Tags or Nội dung unless explicitly asked. Report that Stage is unchanged.
8. Afterwards, close any PSI/runner tabs you opened and move `.playwright-mcp/` artifacts out of the theme root, because hrv theme dev watches it.

## Replacing an earlier dev note (user rule 11/11/2026)
Every comment shows author "User", so neither the author nor the position tells whose comment it is. Delete ONLY a comment whose full text is exactly a note this same job posted earlier (the `dashboard.commentText` of an earlier round's report in the job folder, or a text the user names). A customer's comment, a colleague's, or an old dev note with no such record is never deleted: name it in the report and let the Leader ask.
1. Post the new note first (steps above) and confirm it persisted, so a failure never leaves the issue without a note. Carry over every still-valid line of the old note.
2. Open the issue modal (`?feedback=<N>`, same checks as step 2; `<N>` is the `rowNumber` read by stable id). `OLD` is the exact text to remove, `ID` the stable issue id, `HOST` and `SHOP` the guard values.
3. Resolve the index from a FRESH server read and delete in the SAME `anti.browser.evaluate` (the delete is by position, so a stale index removes the wrong comment): `(async()=>{const d=await (await fetch('/api/getDashboardData?_='+Date.now(),{cache:'no-store'})).json();const r=d.feedback.find(x=>String(x.id)===ID);if(!r||r.host!==HOST||r.shop!==SHOP||Number(r.rowNumber)!==Number(currentCommentRow))return 'GUARD';const hits=JSON.parse(r.devNote||'[]').map((c,i)=>c.text===OLD?i:-1).filter(i=>i>=0);if(hits.length!==1)return 'MATCH_'+hits.length;const k=window.confirm;window.confirm=()=>true;try{await deleteComment(hits[0])}finally{window.confirm=k}return 'SENT'})()`. The page's `deleteComment(commentIndex)` shows a native `confirm()` (answered inside the call above, so no dialog blocks the tab) and posts `deleteComment {rowNumber: currentCommentRow, commentIndex}`. One delete per call; for a second one run the whole call again.
4. Read the comments again from the API by id: `OLD` is gone, the count dropped by exactly 1, every other comment has the same text as before, and the new note appears exactly once. Stage, Deadline, Tags, doneAt and `updatedAt` are unchanged (neither delete nor post moves `updatedAt`). Report the number removed and each exact text (`dashboard.commentsRemoved`, `removedTexts`).

Run live on 11/11/2026 on a real issue: a temporary note was posted (count 2) and the expression above returned `SENT`, `hits` held the note's index, and a fresh API read showed the original comment byte-for-byte, the temporary note gone, and Stage, doneAt, Deadline, Tags, Priority and `updatedAt` unchanged. That `commentIndex` is the position in the issue's `devNote` array is confirmed by that run; no `confirm()` dialog opened and nothing timed out. Not exercised: posting with images, the UI delete button. On any result other than `SENT`, or a failed check in step 4, stop and report; do not retry.
