# Sửa nhận diện automation Page và chăm sóc lại

- Phân loại lời chào và chuỗi trả lời nhanh của Meta/Page/Ads automation là `meta_page_automation`, không phải Sale/Admin.
- Không để các tin tự động này tạo `manual_pause_until` hoặc hủy hàng đợi AIGUKA với lý do `external_responder_replied`.
- Nhận diện cụm 2+ tin Page trong 5 giây, phát sinh trong 12 giây sau tin khách.
- Sửa đường đồng bộ lịch sử bằng trigger BEFORE để phân loại trước cổng hủy outbound.
- Bổ sung quét phục hồi có batch key cho các hội thoại từng bị bỏ sót.
