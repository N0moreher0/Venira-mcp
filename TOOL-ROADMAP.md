# Venira MCP Coding — Tool Roadmap

## 1) Mục tiêu tổng thể
- Giữ venira là MCP layer tách khỏi OpenCode.
- Cải thiện UX chọn tool, output, tốc độ workflow, và tính dễ test.
- Không cần native hoá ngay; native hoá chỉ là option dài hạn nếu open-code-only.

## 2) Nguyên tắc thiết kế tool
- Native cho 1 op đơn giản, output không quan trọng.
- Venira cho read-heavy, batch, async shell, structured envelope.
- Opencode tool cho metadata/session/worktree/MCP resource.
- Code Mode helper chỉ dùng để khám phá catalog, không thay thế tool thật.

## 3) Roadmap chi tiết

### Giai đoạn 1: Cải thiện discoverability và tool selection
1. Đổi helper Code Mode từ `search` thành `findTools` hoặc `listTools`.
2. Mỗi tool venira bổ sung metadata:
   - `use_when`
   - `avoid_when`
   - `speed_profile`
   - `output_kind`
   - `batch_safe`
3. Tạo policy file ngắn trong repo, ví dụ `.opencode/tool-policy.md`:
   - native-first cho single small ops
   - venira-first cho read-heavy workflow
   - batch-first với read-only
   - async shell cho build/test
4. Viết guideline chọn tool dạng decision tree cho model:
   - đọc nhiều file? → `project_read_batch`
   - shell lâu? → `project_shell_run` + `project_shell_status`
   - cần metadata OpenCode? → `opencode.*`
   - khám phá tool không chắc? → `findTools`

### Giai đoạn 2: Nâng cấp output và UX
1. Chuẩn hóa response envelope ở mọi tool:
   - `status`
   - `request_id`
   - `kind`
   - `data`
   - `truncated`
   - `hint`
2. Thêm `hint` cho các lỗi phổ biến:
   - path ngoài workspace
   - file không tồn tại
   - batch chạm limit
   - search limit quá nhỏ
3. Cho phép compact output mode mạnh hơn:
   - `VENIRA_PRETTY=0` mặc định
   - thêm `VENIRA_OUTPUT_MODE=full|compact|summary`
4. Bổ sung phần `summary` cho kết quả dài:
   - `matches_preview`
   - `files_scanned`
   - `next_start_line`
   - `suggested_narrowing`
5. Chuẩn hóa error format:
   - `code`
   - `message`
   - `retryable`
   - `suggestion`

### Giai đoạn 3: Tối ưu tốc độ workflow
1. Mở rộng cache đọc:
   - hiện tại `read_file`, `get_file_info`
   - bổ sung cache cho `list_files` ngắn hạn nếu cần
2. Thêm cache index cho `project_search`:
   - index theo file + line
   - invalidation bằng mtime/size
3. Tối ưu `project_read_batch`:
   - giữ batch nhưng tránh parallel ở tầng Rust nếu audit lock là bottleneck
   - thêm `max_response_bytes_per_item`
4. Thêm prewarm mạnh hơn:
   - mở capability sớm
   - warm filesystem cache
   - ping host khi start
5. Bench tiêu chuẩn:
   - `bench.ts` cho corehost
   - `bench-mcp.ts` cho end-to-end
   - thêm test scenario:
     - batch 8 cold
     - batch 8 cached
     - shell async
     - search rộng vs hẹp

### Giai đoạn 4: Tăng reliability và observability
1. Thêm request tracing:
   - `request_id` truyền xuyên suốt
   - log structured output
   - theo dõi p50/p95 per operation
2. Thêm health tool:
   - `project_health`
   - trả capability status, cache stats, queue depth, shell active runs
3. Thêm self-test mode:
   - `npm run verify` giữ nguyên
   - thêm `npm run doctor` để check:
     - corehost path
     - data dir
     - workspace lock
     - permission mode
     - audit db reachable
4. Thêm structured diagnostics trong error:
   - audit_unavailable
   - capability_expired
   - path_escape
   - batch_resource_limit
   - shell_timeout

### Giai đoạn 5: Mở rộng capability tool
1. Thêm tool nhóm read-heavy:
   - `project_diff_files` (nếu có backend)
   - `project_outline_symbol`
   - `project_read_ranges`
2. Thêm tool nhóm code context:
   - `project_symbol_references`
   - `project_file_symbols`
   - `project_recent_files`
3. Thêm tool nhóm workflow:
   - `project_plan_read_batch`
   - `project_selective_search`
   - `project_explain_error`
4. Bổ sung shell UX:
   - tail output
   - exit code sớm
   - timeout policy rõ ràng
   - cancel safety

### Giai đoạn 6: Cân nhắc native hoá
1. Chỉ native hoá khi:
   - OpenCode là runtime duy nhất
   - overhead MCP đo được thành vấn đề thật
   - team chấp nhận maintain tool trong OpenCode
2. Nếu native hoá:
   - giữ structured envelope
   - giữ batch + async shell
   - thêm benchmark native vs MCP
   - giữ khả năng port lại MCP nếu cần
3. Nếu không native hoá:
   - tối ưu transport
   - giảm serialize cost
   - cache catalog
   - tối ưu startup/warm-up

## 4) Ưu tiên nên làm ngay
- P0: đổi tên helper `search` → `findTools`
- P0: thêm `use_when`/`avoid_when` cho từng tool
- P1: chuẩn hóa `hint` trong error
- P1: tăng cache cho read-heavy workflow
- P2: thêm `project_health`
- P2: mở rộng bench/verify scenarios

## 5) Định nghĩa thành công
- Model chọn đúng tool theo quy tắc rõ, không bị trộn native/venira/opencode.
- Output đủ rõ để debug mà không cần dump JSON dài.
- Workflow nhiều thao tác giảm round-trip rõ rệt.
- Tốc độ chấp nhận được, chênh lệch với native không làm xấu UX.
- Có test/bench chứng minh cải thiện, không chỉ cảm tính.
