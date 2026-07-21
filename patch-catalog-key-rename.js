import fs from "node:fs";
import { spawnSync } from "node:child_process";

const marker = "AIGUKA_CATALOG_KEY_RENAME_V2";
const assetVersion = "20260721-catalog-rename-v2";

function patchHtml() {
  const file = "public/drive-slides-v8.html";
  let source = fs.readFileSync(file, "utf8");

  source = source.replace(
    /<div class="notice warning"><b>Mã catalog là khóa kỹ thuật và được khóa sau khi tạo\.<\/b>[^<]*(?:<b>[^<]*<\/b>[^<]*)?<\/div>/,
    '<div class="notice warning"><b>Có thể sửa mã catalog.</b> Khi bấm Lưu, hệ thống tự chuyển Mapping QC, nguồn ảnh Drive, catalog cha/con và quy tắc nhận diện sang mã mới; mã cũ được giữ làm alias để dữ liệu cũ tiếp tục hoạt động.</div>',
  );

  if (!source.includes('id="c_original_key"')) {
    source = source.replace(
      '<form id="catalogForm" onsubmit="saveCatalog(event)"><input type="hidden" id="c_is_new" value="1">',
      '<form id="catalogForm" onsubmit="saveCatalog(event)"><input type="hidden" id="c_is_new" value="1"><input type="hidden" id="c_original_key">',
    );
  }

  source = source
    .replace(/href="\/admin\/drive-slides-v8\.css(?:\?[^\"]*)?"/, `href="/admin/drive-slides-v8.css?v=${assetVersion}"`)
    .replace(/src="\/admin\/drive-slides-v8-core\.js(?:\?[^\"]*)?"/, `src="/admin/drive-slides-v8-core.js?v=${assetVersion}"`)
    .replace(/src="\/admin\/drive-slides-v8-render\.js(?:\?[^\"]*)?"/, `src="/admin/drive-slides-v8-render.js?v=${assetVersion}"`);

  if (!source.includes(`<!-- ${marker} -->`)) {
    source = source.replace("</body>", `<!-- ${marker} --></body>`);
  }
  fs.writeFileSync(file, source, "utf8");
}

function patchRender() {
  const file = "public/drive-slides-v8-render.js";
  let source = fs.readFileSync(file, "utf8");
  if (source.includes(`// ${marker}`)) return;

  const openStart = source.indexOf("function openCatalog(catalog = {}, requestedParent = '') {");
  const setActiveStart = source.indexOf("\nasync function setCatalogActive(", openStart);
  if (openStart < 0 || setActiveStart < 0) {
    throw new Error("CATALOG_RENAME_RENDER_FUNCTIONS_NOT_FOUND");
  }

  const replacement = `function openCatalog(catalog = {}, requestedParent = '') {
  const isNew = !catalog.catalog_key;
  const key = String(catalog.catalog_key || '');
  const excluded = key ? catalogDescendantKeys(key, state.allCatalogs) : new Set();
  const parentRows = catalogTreeRows(state.allCatalogs.filter(row =>
    !excluded.has(String(row.catalog_key)) && (row.is_active !== false || String(row.catalog_key) === String(catalog.parent_key || ''))
  ));
  fillSelect($('c_parent'), parentRows, 'catalog_key', row => \`\${'— '.repeat(row._depth)}\${row.catalog_name} — \${row.catalog_key}\`, 'Không có — catalog cấp cao nhất');
  $('catalogTitle').textContent = isNew ? 'Thêm Catalog' : 'Sửa Catalog';
  $('c_is_new').value = isNew ? '1' : '0';
  if ($('c_original_key')) $('c_original_key').value = key;
  $('c_key').value = key;
  $('c_key').readOnly = false;
  $('c_key').classList.remove('locked-input');
  $('c_key_help').textContent = isNew
    ? 'Tự tạo từ tên; chỉ dùng chữ thường, số và dấu gạch dưới.'
    : 'Có thể sửa mã trực tiếp. Khi lưu, hệ thống tự chuyển Mapping và giữ mã cũ làm alias.';
  $('c_name').value = catalog.catalog_name || '';
  $('c_parent').value = requestedParent || catalog.parent_key || '';
  $('c_sendable').checked = catalog.is_sendable !== false;
  $('c_active').checked = catalog.is_active !== false;
  $('c_drive_path').value = catalog.folder_path || catalog.drive_folder_id || 'Chưa gán thư mục Drive';
  $('c_drive_button').hidden = isNew;
  previewCatalogHierarchy();
  openModal('catalogModal');
  (isNew ? $('c_name') : $('c_key')).focus();
}

async function saveCatalog(event) {
  event.preventDefault();
  const isNew = $('c_is_new').value === '1';
  const catalogKey = $('c_key').value.trim().toLowerCase();
  const originalCatalogKey = String($('c_original_key')?.value || catalogKey).trim().toLowerCase();
  const keyChanged = !isNew && originalCatalogKey !== catalogKey;
  const active = $('c_active').checked;
  if (!/^[a-z0-9][a-z0-9_]{0,79}$/.test(catalogKey)) {
    status('Mã catalog chỉ gồm chữ thường không dấu, số và dấu gạch dưới.', true);
    return;
  }
  if (!isNew && !active && !confirm('Tắt Catalog này? Hệ thống sẽ chặn nếu còn catalog con hoặc Mapping đang sử dụng.')) return;
  busy(true);
  try {
    if (keyChanged) {
      await api('/api/v8-mapping-center/catalog/rename', {
        method: 'POST',
        body: JSON.stringify({
          old_catalog_key: originalCatalogKey,
          new_catalog_key: catalogKey
        })
      });
    }
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
    if ($('c_original_key')) $('c_original_key').value = catalogKey;
    closeModal('catalogModal');
    await loadAll(false);
    status(isNew
      ? 'Đã tạo Catalog mới.'
      : (keyChanged ? \`Đã đổi mã catalog từ \${originalCatalogKey} thành \${catalogKey}.\` : 'Đã cập nhật Catalog.'));
  } catch (error) {
    const blockers = error.data?.blockers;
    const detail = blockers ? [
      blockers.children?.length ? \`\${blockers.children.length} catalog con đang bật\` : '',
      blockers.ad_mappings?.length ? \`\${blockers.ad_mappings.length} Mapping QC đang dùng\` : '',
      blockers.slide_mappings?.length ? \`\${blockers.slide_mappings.length} Mapping Drive đang dùng\` : ''
    ].filter(Boolean).join(', ') : '';
    status(detail ? \`\${error.message} (\${detail})\` : error.message, true);
  } finally {
    busy(false);
  }
}
`;

  source = source.slice(0, openStart) + replacement + source.slice(setActiveStart);
  source = `// ${marker}\n${source}`;
  fs.writeFileSync(file, source, "utf8");
}

function patchRoute() {
  const file = "src/routes/mappingCenterRoutes.js";
  let source = fs.readFileSync(file, "utf8");

  source = source.replace(
    "        app.get(`/admin/${fileName}`, (_req, res) => res.sendFile(path.join(publicDirectory, fileName)));",
    "        app.get(`/admin/${fileName}`, (_req, res) => { res.set('Cache-Control', 'no-store, max-age=0'); res.sendFile(path.join(publicDirectory, fileName)); });",
  );
  source = source.replace(
    "    app.get('/drive-slides', (_req, res) => res.sendFile(path.join(publicDirectory, 'drive-slides-v8.html')));",
    "    app.get('/drive-slides', (_req, res) => { res.set('Cache-Control', 'no-store, max-age=0'); res.sendFile(path.join(publicDirectory, 'drive-slides-v8.html')); });",
  );

  if (!source.includes("/api/v8-mapping-center/catalog/rename")) {
    const routeMarker = "    app.post('/api/v8-mapping-center/catalog', jsonBody, requireMappingWrite, async (req, res) => {";
    const routeCode = `    // ${marker}
    app.post('/api/v8-mapping-center/catalog/rename', jsonBody, requireMappingWrite, async (req, res) => {
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
            if (!existing) return res.status(404).json({ ok: false, error: \`Không tìm thấy catalog \${oldCatalogKey}.\` });
            if (rows.some(row => String(row.catalog_key) === newCatalogKey)) {
                return res.status(409).json({ ok: false, error: \`Mã catalog \${newCatalogKey} đã tồn tại.\` });
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
            await logCatalogChange('rename_catalog_mapping', newCatalogKey, existing, saved || { catalog_key: newCatalogKey, rename_result: result });
            return res.json({ ok: true, result, saved });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: error.message, details: error.details || null });
        }
    });

`;
    if (!source.includes(routeMarker)) throw new Error("CATALOG_RENAME_ROUTE_ANCHOR_NOT_FOUND");
    source = source.replace(routeMarker, routeCode + routeMarker);
  }

  fs.writeFileSync(file, source, "utf8");
}

patchHtml();
patchRender();
patchRoute();
for (const file of ["public/drive-slides-v8-render.js", "src/routes/mappingCenterRoutes.js"]) {
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) {
    throw new Error(`CATALOG_RENAME_SYNTAX:${file}:${syntax.stderr || syntax.stdout}`);
  }
}
console.log("[AIGUKA] Catalog key editing v2 installed with cache-safe assets");
