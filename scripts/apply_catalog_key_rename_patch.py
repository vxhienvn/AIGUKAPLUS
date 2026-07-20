from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {path}, found {count}")
    file_path.write_text(source.replace(old, new, 1), encoding="utf-8")


replace_once(
    "public/drive-slides-v8.html",
    '<div class="notice warning"><b>Mã catalog là khóa kỹ thuật và được khóa sau khi tạo.</b> Đổi mã có thể làm hỏng Mapping QC và nguồn ảnh đang dùng. Muốn sửa thư mục/ảnh của catalog, dùng nút <b>Sản phẩm & Drive</b> tại từng dòng.</div>',
    '<div class="notice warning"><b>Có thể đổi mã catalog khi cần tách hoặc chuẩn hóa nhóm.</b> Hệ thống sẽ tự chuyển các Mapping QC, nguồn ảnh Drive, catalog cha/con và quy tắc nhận diện sang mã mới; mã cũ vẫn được giữ làm alias để dữ liệu cũ tiếp tục hoạt động. Chỉ đổi khi đã xác định rõ mã mới.</div>'
)

replace_once(
    "public/drive-slides-v8.html",
    '<form id="catalogForm" onsubmit="saveCatalog(event)"><input type="hidden" id="c_is_new" value="1">',
    '<form id="catalogForm" onsubmit="saveCatalog(event)"><input type="hidden" id="c_is_new" value="1"><input type="hidden" id="c_original_key">'
)

replace_once(
    "public/drive-slides-v8-render.js",
    """  $('c_is_new').value = isNew ? '1' : '0';
  $('c_key').value = key;
  $('c_key').readOnly = !isNew;
  $('c_key').classList.toggle('locked-input', !isNew);
  $('c_key_help').textContent = isNew
    ? 'Tự tạo từ tên; chỉ dùng chữ thường, số và dấu gạch dưới.'
    : 'Mã catalog đã khóa để bảo vệ các Mapping đang tham chiếu.';""",
    """  $('c_is_new').value = isNew ? '1' : '0';
  $('c_original_key').value = key;
  $('c_key').value = key;
  $('c_key').readOnly = false;
  $('c_key').classList.remove('locked-input');
  $('c_key_help').textContent = isNew
    ? 'Tự tạo từ tên; chỉ dùng chữ thường, số và dấu gạch dưới.'
    : 'Có thể đổi mã. Hệ thống sẽ tự chuyển toàn bộ Mapping và giữ mã cũ làm alias.';"""
)

replace_once(
    "public/drive-slides-v8-render.js",
    """async function saveCatalog(event) {
  event.preventDefault();
  const isNew = $('c_is_new').value === '1';
  const catalogKey = $('c_key').value.trim().toLowerCase();
  const active = $('c_active').checked;
  if (!isNew && !active && !confirm('Tắt Catalog này? Hệ thống sẽ chặn nếu còn catalog con hoặc Mapping đang sử dụng.')) return;
  busy(true);
  try {
    await api('/api/v8-mapping-center/catalog', {
      method: 'POST',
      body: JSON.stringify({
        is_new: isNew,
        catalog_key: catalogKey,
        catalog_name: $('c_name').value.trim(),
        parent_key: $('c_parent').value || null,
        is_sendable: $('c_sendable').checked,
        is_active: active
      })
    });
    closeModal('catalogModal');
    await loadAll(false);
    status(isNew ? 'Đã tạo Catalog mới.' : 'Đã cập nhật Catalog.');
  } catch (error) {
    const blockers = error.data?.blockers;
    const detail = blockers ? [
      blockers.children?.length ? `${blockers.children.length} catalog con đang bật` : '',
      blockers.ad_mappings?.length ? `${blockers.ad_mappings.length} Mapping QC đang dùng` : '',
      blockers.slide_mappings?.length ? `${blockers.slide_mappings.length} Mapping Drive đang dùng` : ''
    ].filter(Boolean).join(', ') : '';
    status(detail ? `${error.message} (${detail})` : error.message, true);
  } finally {
    busy(false);
  }
}""",
    """async function saveCatalog(event) {
  event.preventDefault();
  const isNew = $('c_is_new').value === '1';
  const catalogKey = $('c_key').value.trim().toLowerCase();
  const originalCatalogKey = String($('c_original_key')?.value || catalogKey).trim().toLowerCase();
  const keyChanged = !isNew && originalCatalogKey !== catalogKey;
  const active = $('c_active').checked;
  if (keyChanged && !confirm(`Đổi mã catalog từ “${originalCatalogKey}” thành “${catalogKey}”? Hệ thống sẽ tự chuyển toàn bộ Mapping, nguồn ảnh và cấu trúc cha/con; mã cũ vẫn được giữ làm alias.`)) return;
  if (!isNew && !active && !confirm('Tắt Catalog này? Hệ thống sẽ chặn nếu còn catalog con hoặc Mapping đang sử dụng.')) return;
  busy(true);
  try {
    await api('/api/v8-mapping-center/catalog', {
      method: 'POST',
      body: JSON.stringify({
        is_new: isNew,
        catalog_key: keyChanged ? originalCatalogKey : catalogKey,
        catalog_name: $('c_name').value.trim(),
        parent_key: $('c_parent').value || null,
        is_sendable: $('c_sendable').checked,
        is_active: active
      })
    });
    if (keyChanged) {
      await api('/api/v8-mapping-center/catalog/rename', {
        method: 'POST',
        body: JSON.stringify({
          old_catalog_key: originalCatalogKey,
          new_catalog_key: catalogKey
        })
      });
    }
    closeModal('catalogModal');
    await loadAll(false);
    status(isNew
      ? 'Đã tạo Catalog mới.'
      : (keyChanged ? `Đã đổi mã catalog từ ${originalCatalogKey} thành ${catalogKey}.` : 'Đã cập nhật Catalog.'));
  } catch (error) {
    const blockers = error.data?.blockers;
    const detail = blockers ? [
      blockers.children?.length ? `${blockers.children.length} catalog con đang bật` : '',
      blockers.ad_mappings?.length ? `${blockers.ad_mappings.length} Mapping QC đang dùng` : '',
      blockers.slide_mappings?.length ? `${blockers.slide_mappings.length} Mapping Drive đang dùng` : ''
    ].filter(Boolean).join(', ') : '';
    status(detail ? `${error.message} (${detail})` : error.message, true);
  } finally {
    busy(false);
  }
}"""
)

route_marker = "    app.post('/api/v8-mapping-center/catalog', jsonBody, requireMappingWrite, async (req, res) => {"
route_code = """    app.post('/api/v8-mapping-center/catalog/rename', jsonBody, requireMappingWrite, async (req, res) => {
        try {
            const oldCatalogKey = String(req.body?.old_catalog_key || '').trim().toLowerCase();
            const newCatalogKey = String(req.body?.new_catalog_key || '').trim().toLowerCase();
            const validKey = value => /^[a-z0-9][a-z0-9_]{0,79}$/.test(value);
            if (!validKey(oldCatalogKey) || !validKey(newCatalogKey)) {
                return res.status(400).json({ ok: false, error: 'Mã catalog chỉ gồm chữ thường không dấu, số và dấu gạch dưới.' });
            }
            if (oldCatalogKey === newCatalogKey) return res.json({ ok: true, unchanged: true });

            const rows = await loadCatalogAdminRows();
            const existing = rows.find(row => String(row.catalog_key) === oldCatalogKey) || null;
            if (!existing) return res.status(404).json({ ok: false, error: `Không tìm thấy catalog ${oldCatalogKey}.` });
            if (rows.some(row => String(row.catalog_key) === newCatalogKey)) {
                return res.status(409).json({ ok: false, error: `Mã catalog ${newCatalogKey} đã tồn tại.` });
            }

            const result = await supabaseRest('rpc/v8_admin_rename_catalog_key', {
                method: 'POST',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify({
                    p_old_catalog_key: oldCatalogKey,
                    p_new_catalog_key: newCatalogKey
                })
            });
            const afterRows = await loadCatalogAdminRows();
            const saved = afterRows.find(row => String(row.catalog_key) === newCatalogKey) || null;
            await logCatalogChange(
                'rename_catalog_mapping',
                newCatalogKey,
                existing,
                saved || { catalog_key: newCatalogKey, rename_result: result }
            );
            return res.json({ ok: true, result, saved });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: error.message, details: error.details || null });
        }
    });

"""
replace_once("src/routes/mappingCenterRoutes.js", route_marker, route_code + route_marker)

Path("tests/catalog-key-rename.test.js").write_text("""import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const renderSource = fs.readFileSync('public/drive-slides-v8-render.js', 'utf8');
const htmlSource = fs.readFileSync('public/drive-slides-v8.html', 'utf8');
const routeSource = fs.readFileSync('src/routes/mappingCenterRoutes.js', 'utf8');
const migrationSource = fs.readFileSync('supabase/migrations/20260721024000_allow_safe_catalog_key_rename.sql', 'utf8');

test('Catalog cũ cho phép sửa mã và gửi yêu cầu đổi mã an toàn', () => {
  assert.match(htmlSource, /id="c_original_key"/);
  assert.match(htmlSource, /Có thể đổi mã catalog khi cần tách hoặc chuẩn hóa nhóm/);
  assert.match(renderSource, /\$\('c_key'\)\.readOnly = false/);
  assert.match(renderSource, /\/api\/v8-mapping-center\/catalog\/rename/);
  assert.match(renderSource, /old_catalog_key: originalCatalogKey/);
  assert.match(renderSource, /new_catalog_key: catalogKey/);
});

test('Backend dùng RPC giao dịch và migration giữ mã cũ làm alias', () => {
  assert.match(routeSource, /app\.post\('\/api\/v8-mapping-center\/catalog\/rename'/);
  assert.match(routeSource, /rpc\/v8_admin_rename_catalog_key/);
  assert.match(migrationSource, /create or replace function public\.v8_admin_rename_catalog_key/);
  assert.match(migrationSource, /'legacy', true, 'Mã cũ, tự chuyển sang '/);
  assert.match(migrationSource, /update public\.ad_mappings/);
  assert.match(migrationSource, /update public\.v8_drive_assets/);
  assert.match(migrationSource, /delete from public\.v8_product_catalog where catalog_key = v_old_key/);
});
""", encoding="utf-8")

print("Catalog key rename patch applied successfully.")
