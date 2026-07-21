# Sửa nhận diện automation Page và chăm sóc lại

- Xác định AIcake không phải nguồn chặn hiện tại; Meta/Page/Ads automation cũ vẫn đang gửi lời chào và chuỗi trả lời nhanh.
- Phân loại các tin này là `meta_page_automation`, không phải Sale/Admin.
- Không để automation tạo `manual_pause_until`, làm dừng chăm sóc hoặc hủy hàng đợi AIGUKA với lý do `external_responder_replied`.
- Nhận diện cả mẫu tin cố định, cụm trả lời nhanh và các tin nằm cạnh một tin automation trong 15 giây đầu sau tin khách.
- Đưa bộ phân loại chạy trước cổng hủy outbound, kể cả khi đồng bộ lịch sử Meta cập nhật lại bản ghi cũ.
- Sửa hai cổng chuẩn bị/hoàn tất chăm sóc: chỉ tin của AIGUKA hoặc phản hồi thật của Sale/Admin mới được coi là có người đã chăm; tin Page automation bị bỏ qua.
- Bổ sung quét phục hồi có batch key cho các hội thoại từng bị bỏ sót.
- Đã phân loại lại dữ liệu lịch sử, sửa trạng thái hội thoại và chạy quét phục hồi trên Page Tổng Kho.
- Sau lần sửa cuối, 13 tin chăm sóc được gửi thành công; 3 lượt từng bị hủy nhầm đã được quét lại và gửi thành công. Không còn yêu cầu AI tồn đọng ở trạng thái pending/processing tại thời điểm kiểm tra.
