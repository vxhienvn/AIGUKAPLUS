AIGUKA Railway Unified Mapping Center patch

Target repository: vxhienvn/AIGUKA
Files:
- server.js
- src/routes/mappingCenterRoutes.js
- public/drive-slides-v8.html
- public/drive-slides-v8.css
- public/drive-slides-v8-core.js
- public/drive-slides-v8-render.js

Behavior:
- Replaces /drive-slides with the new Mapping Center.
- Preserves the old Google Drive/OAuth page at /drive-slides-legacy.
- Reads current ads from Meta and current referral data, not old seed data.
- Supports create/edit/disable Ad Mapping.
- Supports product/catalog -> Drive mapping.
- Supports OFF/OBSERVE/ACTIVE per Page.
- Supports mapping and slide preview tests without sending to customers.
- Uses Supabase service-role credentials already present in Railway.

Required Railway variables:
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY)
Optional: MAPPING_ADMIN_KEY
