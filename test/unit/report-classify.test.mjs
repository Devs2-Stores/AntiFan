// classifyNeedsInput: questions only the user may answer vs. ones the Leader can settle.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { classifyNeedsInput, validateReportText } from "../../scripts/leader/report.mjs";

describe("classifyNeedsInput", () => {
  const onlyUser = [
    ["Anh đăng nhập lại dashboard giúp em (hết phiên)?", ["Đã đăng nhập", "Bỏ qua"]],
    ["Cần mã OTP để vào shop", ["Gửi OTP", "Hủy"]],
    ["Bật 2FA cho tài khoản?", ["Có", "Không"]],
    ["What is the admin password?", ["a", "b"]],
    ["Cho em API token mới", ["x", "y"]],
    ["Thanh toán gói Pro nhé?", ["Có", "Không"]],
    ["Shall I publish the theme now?", ["publish", "wait"]],
    ["Xóa các file cũ trong theme?", ["Xóa", "Giữ"]],
    ["Push with --force?", ["yes", "no"]],
    ["Cần --prune để dọn file thừa", ["ok", "no"]],
    ["Đẩy lên theme khác (id 12345)?", ["Có", "Không"]],
    ["Dùng tài khoản của anh để cấp quyền?", ["Có", "Không"]],
    ["Use your account to sign in?", ["a", "b"]],
  ];
  for (const [q, opts] of onlyUser) {
    test(`onlyUser: ${q}`, () => {
      const r = classifyNeedsInput(q, opts);
      assert.equal(r.onlyUser, true);
      assert.ok(r.reasons.length >= 1);
    });
  }

  const leaderCanDecide = [
    ["Cột Ghi chú nên ghi ngắn hay đầy đủ?", ["Ngắn", "Đầy đủ"]],
    ["Which padding looks right on the product card?", ["12px", "16px"]],
    ["Banner hero nên cao 400px hay 480px?", ["400px", "480px", "Giữ nguyên"]],
  ];
  for (const [q, opts] of leaderCanDecide) {
    test(`not onlyUser: ${q}`, () => {
      assert.deepEqual(classifyNeedsInput(q, opts), { onlyUser: false, reasons: [] });
    });
  }

  test("accent-insensitive and looks at the options too", () => {
    assert.equal(classifyNeedsInput("Anh dang nhap giup em", ["a", "b"]).onlyUser, true);
    assert.equal(classifyNeedsInput("Chọn cách làm", ["Xóa bản cũ", "Giữ"]).onlyUser, true);
  });

  test("validate-report data carries onlyUser and reasons", () => {
    const job = { job: "j", slug: "s", subject: { issueId: "1", host: "Taiz", shop: "s", sheetId: "" } };
    const json = {
      schema: "leader-report/1",
      status: "NEEDS_INPUT",
      job: "j",
      round: 1,
      guard: { issueId: "1", host: "Taiz", shop: "s", sheetId: "" },
      needsInput: { question: "Anh đăng nhập OTP giúp em", options: ["Xong", "Hủy"] },
    };
    const text = `STATUS: NEEDS_INPUT\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`\n`;
    const v = validateReportText(text, job, 1);
    assert.deepEqual(v.errors, []);
    assert.equal(v.needsInput.onlyUser, true);
    assert.ok(v.needsInput.reasons.includes("login/credential"));
  });
});

describe('classifyNeedsInput word forms', () => {
  for (const q of ['The theme was deleted, ok?', 'Deleting the old files?', 'Already published?', 'Publishing now?']) {
    test(q, () => assert.equal(classifyNeedsInput(q, ['a', 'b']).onlyUser, true));
  }
});
