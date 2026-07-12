# AIGUKA V8 Admin trên Railway

Gói này biến các giao diện Supabase Edge Function thành website HTML online thật trên Railway.
Railway chỉ phục vụ frontend và proxy API; token Meta và dữ liệu vẫn nằm trong Supabase.

## Cách triển khai bằng GitHub

1. Giải nén gói này.
2. Tạo một repository GitHub riêng tư.
3. Upload toàn bộ file trong thư mục này vào repository.
4. Tại Railway, chọn **Deploy from GitHub repo** và chọn repository vừa tạo.
5. Vào service Railway → **Variables**, thêm:

```env
SUPABASE_URL=https://ezygfpeeqbbirdeazene.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable key hoặc anon key của Supabase>
```

Không đưa các khóa sau lên Railway frontend:

- `SUPABASE_SERVICE_ROLE_KEY`
- Page Access Token Meta
- `META_APP_SECRET`
- `AIGUKA_V8_ADMIN_SECRET`

Mã quản trị vẫn được người dùng nhập khi mở giao diện và chỉ giữ trong session của trình duyệt.

6. Chờ Railway deploy thành công.
7. Vào **Settings → Networking → Generate Domain**.
8. Mở domain Railway vừa tạo.

## Các địa chỉ

- `/` hoặc `/admin-v8`: Dashboard
- `/control-center`: quản trị Page, PSID TEST và chế độ Bot
- `/readiness`: tiến độ và blocker
- `/observe`: OBSERVE và mapping
- `/learning`: AI Learning
- `/health`: kiểm tra service

## Vì sao cần Railway

Supabase vẫn nhận Webhook Meta và cung cấp Database/API. Railway chỉ trả HTML đúng `text/html`, đồng thời proxy API cùng origin để tránh lỗi `file://`, CORS và `401` do giao diện cục bộ.
