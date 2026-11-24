// Nội dung tiếng Việt. Giữ nguyên tên tool, biến môi trường và lệnh bằng tiếng Anh.
export default {
  code: "vi",
  htmlLang: "vi",
  dateLocale: "vi-VN",
  name: "Tiếng Việt",
  seo: {
    siteTitle: "venira-mcp: bộ công cụ workspace cho coding agent",
    siteDescription:
      "venira-mcp là MCP server cho phép coding agent đọc, sửa file và chạy lệnh trong một thư mục dự án, có nhật ký kiểm toán và khôi phục không cần git.",
  },
  ui: {
    skip: "Bỏ qua, tới nội dung",
    docs: "Tài liệu",
    blog: "Blog",
    github: "GitHub",
    npm: "npm",
    language: "Ngôn ngữ",
    mainNav: "Chính",
    copy: "Sao chép",
    copied: "Đã chép",
    docsMenu: "Các trang tài liệu",
    published: "Đăng ngày",
    allPosts: "Tất cả bài viết",
    latestPosts: "Từ blog",
    notFoundTitle: "Không tìm thấy trang",
    notFoundText: "Trang này không tồn tại hoặc đã được chuyển đi.",
    backHome: "Về trang chủ",
    license: "Giấy phép AGPL-3.0-only",
    source: "Mã nguồn trên GitHub",
    rss: "RSS",
    docsIndexTitle: "Tài liệu",
    docsIndexLead: "Cài venira-mcp, chọn chế độ tool và quyết định agent được phép làm đến đâu.",
    blogIndexTitle: "Blog",
    blogIndexLead: "Ghi chú phát hành, benchmark và ghi chú thiết kế của venira-mcp.",
    noPosts: "Chưa có bài viết nào.",
    onThisPage: "Trong trang này",
  },
  home: {
    heroTitle: "Cho coding agent một workspace. Giữ lại mọi biên lai.",
    heroLead:
      "venira-mcp là MCP server cho Claude Desktop, OpenCode, Cursor, VS Code và Codex. Agent đọc, sửa file và chạy lệnh trong đúng một thư mục dự án, mọi lệnh gọi đều được ghi vào nhật ký kiểm toán, và bạn khôi phục bằng checkpoint mà không cần git.",
    installLabel: "Cài trong dự án của bạn, rồi khởi động lại client",
    worksWith: "Cần Node 20 trở lên. Một dependency native (better-sqlite3), không cần binary ngoài.",
    ledgerCaption: "Phiên làm việc ví dụ",
    ledgerNote: "Chỉ để minh hoạ. Kết quả theo profile bảo mật `balanced` mặc định.",
    ledgerCols: { n: "STT", tool: "Tool", detail: "Việc đã xảy ra", verdict: "Kết quả" },
    verdicts: { allowed: "cho phép", ask: "cần duyệt", deny: "từ chối" },
    ledgerRows: [
      { tool: "read_file", text: "Đọc tám file trong một lệnh batch", verdict: "allowed" },
      {
        tool: "snapshot",
        text: "Tạo checkpoint `snap-20261113-001500-3f9ac2` trước khi refactor",
        verdict: "allowed",
      },
      {
        tool: "edit_file",
        text: "Đổi tên `loadConfig` thành `readConfig`. Lý do được lưu cùng lệnh gọi",
        verdict: "allowed",
      },
      { tool: "shell_run", text: "`Remove-Item -Recurse -Force build`", verdict: "ask" },
      { tool: "shell_run", text: "`rm -rf /`", verdict: "deny" },
      {
        tool: "snapshot",
        text: "Khôi phục checkpoint, xem trước bằng `dry_run` trước",
        verdict: "allowed",
      },
    ],
    trustTitle: "Thiết kế để bạn kiểm tra được",
    trustLead:
      "Agent có quyền ghi thì cần có dấu vết. Đây là những phần venira-mcp cung cấp cho việc đó.",
    trustItems: [
      {
        title: "Mọi lệnh gọi đều được ghi lại",
        text: "Mỗi lệnh gọi tool được ghi vào nhật ký kiểm toán SQLite. Các thao tác thay đổi có thể kèm lý do, nên `read_audit` cho thấy agent đã đổi gì và vì sao.",
      },
      {
        title: "Hoàn tác không cần git",
        text: "`snapshot` tạo checkpoint theo nội dung và khôi phục nguyên tử từng file. Xem trước việc khôi phục bằng `dry_run` trước khi quyết định.",
      },
      {
        title: "Luật chạy trước shell",
        text: "Lệnh được phân loại allow, ask hoặc deny trước khi thực thi. Ở profile mặc định `rm -rf /` bị từ chối và các lệnh xoá đệ quy kèm force cần bạn duyệt.",
      },
      {
        title: "Sửa trên nội dung đã cũ sẽ bị từ chối",
        text: "`write_file` và `edit_file` nhận `expected_sha256`. Nếu file đã đổi trong lúc đó, lệnh trả `stale_content` thay vì ghi đè công việc mới hơn.",
      },
    ],
    limitsTitle: "Là hàng rào bảo vệ, không phải sandbox",
    limitsText:
      "venira-mcp chạy với quyền của user hệ điều hành đã khởi động nó. Khoá workspace giới hạn đường dẫn mà tool file được chạm tới, không giới hạn việc một lệnh shell đã được duyệt làm. Với workspace không tin cậy, hoặc khi cần cô lập thật sự, hãy chạy trong container hoặc VM. Xem [ghi chú bảo mật](/vi/docs/security/).",
    modesTitle: "Chọn mức độ cần phơi ra",
    modesLead:
      "Schema của mỗi tool tốn token ở mọi prompt, nên bộ tool là một thiết lập. Đổi bằng `VENIRA_TOOL_MODE`.",
    modesCols: ["Chế độ", "Số tool", "Phù hợp với", "Gồm"],
    modesRows: [
      ["`minimal`", "2", "Context hẹp nhất; một cửa ngõ", "`execute_js` cộng `shell_status` (~2 737 B)"],
      ["`core`", "18", "Model nhỏ, context hẹp", "Shell, đọc, tìm kiếm, sửa, snapshot, git, memory"],
      ["`default`", "31", "Lập trình hằng ngày", "Core cộng phân tích code, không có CI/CD"],
      ["`expert`", "44", "Quy trình đầy đủ", "Default cộng pull request và CI"],
    ],
    modesNote: "Mỗi chế độ bớt một tool khi tắt `execute_js` (minimal còn 1). Chi tiết ở [chế độ tool](/vi/docs/tool-modes/).",
    speedTitle: "Ít vòng chờ hơn",
    speedLead:
      "Đọc theo batch và kết nối bền vững nhanh hơn việc mở một shell mới cho mỗi lần tra cứu. Thời gian trung vị trên một máy Windows 11, so với `exec_command` của Codex, 20 mẫu ghép cặp cho mỗi giai đoạn.",
    speedCols: ["Công việc", "Cache", "venira-mcp", "exec_command", "Nhanh hơn"],
    speedRows: [
      ["Đọc đầu 8 file, một batch", "miss", "53,5 ms", "962 ms", "18,0 lần"],
      ["Đọc đầu 8 file, một batch", "warm", "39 ms", "1.103,5 ms", "28,3 lần"],
      ["Tìm trong workspace, 49 kết quả", "miss", "118,5 ms", "1.034,5 ms", "8,7 lần"],
      ["Tìm trong workspace, 49 kết quả", "warm", "34,5 ms", "1.018 ms", "29,5 lần"],
    ],
    speedNote:
      "Chỉ một máy và mẫu nhỏ, nên hãy xem đây là xu hướng chứ không phải cam kết. Phương pháp và mẫu thô đều được công bố. Xem [bài phân tích](/vi/blog/benchmark-agent-tool-path/).",
    setupTitle: "Kết nối với client của bạn",
    setupLead:
      "Trình cài đặt tự tìm client và ghi cấu hình giúp bạn. Muốn làm tay thì chọn client của bạn.",
    setupNote:
      "Thay đường dẫn bằng thư mục dự án, khởi động lại client, rồi gọi `health` để kiểm tra server.",
  },
};
