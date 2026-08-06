# V10 Lead table filter contract

The customer table must keep one combined `SĐT/Zalo` column. It must not expose separate phone and Zalo columns in the rendered table.

The contact column filter is a status filter, not a distinct-value filter. It exposes exactly:

- `Có SĐT/Zalo`
- `Không có SĐT/Zalo`

The `Khách hàng` header displays the number of currently visible customer rows. The `SĐT/Zalo` header displays the number of currently visible rows with a contact value. Both counters update after column filtering and table re-rendering.

Other columns retain their ordinary distinct-value filters. The smart contact UI is injected into both the V10 report dashboard and the compatibility admin dashboard so route differences cannot reintroduce the old behavior.
