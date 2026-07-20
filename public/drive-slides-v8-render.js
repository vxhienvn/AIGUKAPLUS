function mappingFolderIds(mapping) {
  const preferred = Array.isArray(mapping?.resolved_folder_ids) && mapping.resolved_folder_ids.length
    ? mapping.resolved_folder_ids
    : (Array.isArray(mapping?.selected_folders) && mapping.selected_folders.length ? mapping.selected_folders : (mapping?.drive_folders || []));
  return [...new Set((Array.isArray(preferred) ? preferred : []).map(value => String(typeof value === 'string' ? value : (value?.id || value?.folder_id || value?.drive_folder_id || ''))).filter(Boolean))];
}

function mappingScope(mapping) {
  if (!mapping) return { title: 'Chưa chọn', detail: '' };
  if (mapping.product_item_key) {
    const catalog = state.catalogs.find(row => row.catalog_key === mapping.product_item_key);
    return { title: catalog?.catalog_name || mapping.product_item_key, detail: 'Sản phẩm/catalog cụ thể' };
  }
  if (mapping.product_group && mapping.product_group !== 'general') {
    const group = state.groups.find(row => row.group_key === mapping.product_group);
    return { title: group?.group_name || mapping.product_group, detail: 'Nhóm sản phẩm' };
  }
  const count = mappingFolderIds(mapping).length;
  return { title: count ? `QC tổng hợp · ${count} thư mục` : 'QC tổng hợp', detail: count ? 'Phạm vi theo các thư mục đã chọn' : 'Chưa chọn phạm vi Drive' };
}

function mappingLabel(mapping) {
  if (!mapping) return '<span class="badge bad">Chưa Mapping</span>';
  const scope = mappingScope(mapping);
  if (!mappingHasUsableScope(mapping)) {
    return `<span class="badge warn">Thiếu nguồn ảnh</span><div style="margin-top:5px"><b>${esc(scope.title)}</b></div><div class="small warn-text">Cần chọn nhóm sản phẩm, catalog hoặc thư mục Drive</div>`;
  }
  return `<span class="badge ok">Đã Mapping</span><div style="margin-top:5px"><b>${esc(scope.title)}</b></div><div class="small muted">${esc(scope.detail)}</div>`;
}

function currentRows() {
  let rows = [...state.currentAds];
  const businessId = $('currentBusiness').value;
  const accountId = $('currentAccount').value;
  const mappingState = $('currentState').value;
  const sort = $('currentSort').value;
  rows = rows.filter(row =>
    (!businessId || String(row.business_id || '') === businessId) &&
    (!accountId || String(row.ad_account_id || row.mapping?.ad_account_id || '') === accountId) &&
    (!mappingState || (mappingState === 'mapped' ? row.mapped : !row.mapped))
  );
  if (sort === 'customers') rows.sort((a, b) => (b.customers || 0) - (a.customers || 0));
  else if (sort === 'unmapped') rows.sort((a, b) => Number(a.mapped) - Number(b.mapped) || new Date(b.last_referral || 0) - new Date(a.last_referral || 0));
  else rows.sort((a, b) => new Date(b.last_referral || 0) - new Date(a.last_referral || 0));
  return rows;
}

function folderListHtml(mapping) {
  const ids = mappingFolderIds(mapping);
  if (!ids.length && !mappingHasUsableScope(mapping)) {
    return '<span class="badge warn">Chưa chọn thư mục Drive</span><div class="small warn-text">QC cũ đã có bản ghi nhưng Bot chưa có nguồn ảnh riêng.</div>';
  }
  if (!ids.length) {
    const scope = mappingScope(mapping);
    return `<span class="badge info">Theo phạm vi sản phẩm</span><div class="small muted">${esc(scope.title)}</div>`;
  }
  const warning = mapping?.folder_sync_status === 'partial' ? '<div class="badge warn">Có đường dẫn cũ chưa đối chiếu được</div>' : '';
  return ids.map(id => `<div class="small">📁 ${esc(folderName(id))}</div>`).join('') + warning;
}

function renderCurrent() {
  const rows = currentRows();
  const body = $('currentBody');
  body.innerHTML = rows.length ? '' : '<tr><td colspan="5" class="empty">Không có QC phù hợp.</td></tr>';
  for (const row of rows) {
    const campaign = row.campaign_name || row.mapping?.campaign_name || 'Chưa đồng bộ tên chiến dịch';
    const adset = row.adset_name || row.mapping?.adset_name || 'Chưa đồng bộ tên nhóm quảng cáo';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><b>${esc(campaign)}</b><div class="small muted">${esc(adset)}</div><div class="small muted">Lần cuối: ${fmtDate(row.last_referral)}</div></td><td><b>${row.customers || 0}</b> khách<div class="small muted">${row.referrals || 0} lượt · ${row.contacts || 0} có liên hệ</div></td><td>${mappingLabel(row.mapping)}</td><td>${folderListHtml(row.mapping)}</td><td><div class="row-actions"><button class="primary" onclick='openMapping(${JSON.stringify(row).replace(/'/g, "&#39;")})'>${row.mapped ? 'Sửa' : 'Mapping ngay'}</button><button onclick='quickTest(${JSON.stringify(row).replace(/'/g, "&#39;")})'>Test</button></div></td>`;
    body.appendChild(tr);
  }
}

function mappingCurrentInfo(adId) { return state.currentAds.find(row => String(row.ad_id) === String(adId)); }

function renderMappings() {
  const query = $('mappingSearch').value.toLocaleLowerCase('vi-VN').trim();
  const mode = $('mappingAge').value;
  let rows = state.mappings.filter(mapping => !query || [mapping.ad_id, mapping.ad_name, mapping.product_group, mapping.product_item_key, mapping.drive_folder, mapping.notes].join(' ').toLocaleLowerCase('vi-VN').includes(query));
  rows = rows.filter(mapping => {
    const current = mappingCurrentInfo(mapping.ad_id);
    return mode === 'all' || (mode === 'current' ? Boolean(current) : !current);
  });
  const body = $('mappingBody');
  body.innerHTML = rows.length ? '' : '<tr><td colspan="6" class="empty">Không có Mapping phù hợp.</td></tr>';
  for (const mapping of rows) {
    const current = mappingCurrentInfo(mapping.ad_id);
    const scope = mappingScope(mapping);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><b>${esc(mapping.ad_name || current?.ad_title || '-')}</b><div class="id">${esc(mapping.ad_id)}</div><div class="small muted">${esc(mapping.ad_account_name || mapping.ad_account_id || '')}</div>${mapping.is_active === false ? '<span class="badge bad">Đã tắt</span>' : ''}</td><td><b>${esc(scope.title)}</b><div class="small muted">${esc(scope.detail)}</div></td><td>${folderListHtml(mapping)}</td><td>${current ? `<span class="badge ok">Đang có khách</span><div class="small">${current.customers || 0} khách · ${fmtDate(current.last_referral)}</div>` : '<span class="badge warn">Không phát sinh gần đây</span>'}</td><td>${fmtDate(mapping.updated_at)}</td><td><div class="row-actions"><button onclick='openMapping(${JSON.stringify({ ...current, mapping }).replace(/'/g, "&#39;")})'>Sửa</button>${mapping.is_active !== false ? `<button class="danger" onclick="disableMapping('${esc(mapping.ad_id)}')">Tắt</button>` : ''}</div></td>`;
    body.appendChild(tr);
  }
}

function catalogDescendantKeys(key) {
  const children = new Map();
  for (const row of state.catalogs) {
    const parent = String(row.parent_key || '');
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(String(row.catalog_key || ''));
  }
  const result = new Set();
  const queue = [String(key || '')];
  while (queue.length) {
    const current = queue.shift();
    if (!current || result.has(current)) continue;
    result.add(current);
    for (const child of children.get(current) || []) queue.push(child);
  }
  return result;
}

function imageCountFor(key) {
  const keys = catalogDescendantKeys(key);
  return (state.data?.asset_summary?.by_catalog || []).reduce((sum, row) => sum + (keys.has(String(row.catalog_key || '')) ? Number(row.images || 0) : 0), 0);
}

function folderImageSummary(ids = []) {
  const selected = new Set(ids.map(String));
  const folders = ids.map(id => state.folders.find(row => String(row.folder_id) === String(id))).filter(Boolean);
  const included = folders.filter(folder => {
    let parentId = String(folder.parent_folder_id || '');
    const visited = new Set();
    while (parentId && !visited.has(parentId)) {
      if (selected.has(parentId)) return false;
      visited.add(parentId);
      parentId = String(state.folders.find(row => String(row.folder_id) === parentId)?.parent_folder_id || '');
    }
    return true;
  });
  return {
    available: included.some(folder => folder.live_drive),
    images: included.reduce((sum, folder) => sum + Number(folder.images ?? folder.total_images ?? folder.direct_images ?? 0), 0)
  };
}

function syncStatusHtml(mapping, syncedCount) {
  if (mapping._catalog_only) return '<span class="badge info">Theo catalog</span>';
  const statusValue = String(mapping.sync_status || 'idle').toLowerCase();
  if (statusValue === 'success') return `<span class="badge ok">Đã đồng bộ</span><div class="small muted">${fmtDate(mapping.last_synced_at)}</div>`;
  if (statusValue === 'error') return `<span class="badge bad">Đồng bộ lỗi</span><div class="small warn-text">${esc(mapping.sync_error || 'Bấm Đồng bộ ngay để thử lại')}</div>`;
  if (statusValue === 'requested') return '<span class="badge warn">Đang chờ đồng bộ</span>';
  return `<span class="badge warn">Chưa đồng bộ</span><div class="small muted">${syncedCount} ảnh Bot đang dùng</div>`;
}

function folderIdsFor(mapping) {
  const values = Array.isArray(mapping?.drive_folder_ids) ? mapping.drive_folder_ids : [];
  const ids = values.map(value => String(typeof value === 'string' ? value : (value?.id || value?.folder_id || value?.drive_folder_id || ''))).filter(Boolean);
  if (!ids.length && mapping?.drive_folder_id) ids.push(String(mapping.drive_folder_id));
  return [...new Set(ids)];
}

function productMappingRows() {
  const rows = [];
  for (const catalog of state.catalogs.filter(row => row.is_sendable !== false)) {
    const mappings = state.slideMappings.filter(row => String(row.product_key) === String(catalog.catalog_key));
    if (mappings.length) rows.push(...mappings.map(mapping => ({ ...catalog, ...mapping, _catalog_only: false })));
    else rows.push({ ...catalog, product_key: catalog.catalog_key, product_name: catalog.catalog_name, drive_folder_id: catalog.drive_folder_id, drive_folder_url: catalog.drive_folder_url, drive_folder_ids: catalog.drive_folder_id ? [catalog.drive_folder_id] : [], page_id: null, is_active: true, sync_status: 'catalog', _catalog_only: true });
  }
  for (const mapping of state.slideMappings) {
    if (!state.catalogs.some(catalog => String(catalog.catalog_key) === String(mapping.product_key))) rows.push({ ...mapping, _catalog_only: false });
  }
  return rows;
}

function renderProducts() {
  const query = $('productSearch').value.toLocaleLowerCase('vi-VN').trim();
  const rows = productMappingRows().filter(mapping => !query || [mapping.product_key, mapping.product_name, mapping.catalog_name, mapping.folder_path, mapping.drive_folder_id, JSON.stringify(mapping.drive_folder_ids || [])].join(' ').toLocaleLowerCase('vi-VN').includes(query));
  const body = $('productBody');
  body.innerHTML = rows.length ? '' : '<tr><td colspan="6" class="empty">Chưa có danh mục sản phẩm/Drive.</td></tr>';
  for (const mapping of rows) {
    const catalog = state.catalogs.find(row => row.catalog_key === mapping.product_key);
    const ids = folderIdsFor(mapping);
    const syncedCount = imageCountFor(mapping.product_key);
    const live = folderImageSummary(ids);
    const shownCount = live.available ? live.images : syncedCount;
    const tr = document.createElement('tr');
    const countDetail = live.available ? `<div class="small muted">Drive: ${live.images} · Bot đã đồng bộ: ${syncedCount}</div>` : `<div class="small muted">${syncedCount} ảnh Bot đã đồng bộ</div>`;
    const action = mapping._catalog_only
      ? `<button onclick='openSlideMapping(${JSON.stringify(mapping).replace(/'/g, "&#39;")})'>Tạo Mapping</button>`
      : `<div class="row-actions"><button onclick='openSlideMapping(${JSON.stringify(mapping).replace(/'/g, "&#39;")})'>Sửa</button><button class="primary" onclick='syncSlideMapping(${JSON.stringify(String(mapping.id))})'>Đồng bộ ngay</button></div>`;
    tr.innerHTML = `<td><b>${esc(mapping.product_name || catalog?.catalog_name || mapping.product_key)}</b><div class="id">${esc(mapping.product_key)}</div><div class="small muted">${esc(mapping.folder_path || catalog?.folder_path || '')}</div></td><td>${esc(mapping.page_id || 'Tất cả Page')}</td><td>${ids.length ? ids.map(id => { const folder = state.folders.find(row => String(row.folder_id) === String(id)); const total = Number(folder?.images ?? folder?.total_images ?? folder?.direct_images ?? 0); const direct = Number(folder?.direct_images ?? total); return `<div>📁 ${esc(folder?.folder_name || id)} <span class="small muted">(${total} ảnh tổng · ${direct} trực tiếp)</span></div>`; }).join('') : '<span class="badge bad">Chưa gán thư mục</span>'}</td><td><b>${shownCount}</b>${shownCount ? '<span class="badge ok" style="margin-left:6px">Có ảnh</span>' : '<span class="badge bad" style="margin-left:6px">Thiếu ảnh</span>'}${countDetail}</td><td>${syncStatusHtml(mapping, syncedCount)}</td><td>${action}</td>`;
    body.appendChild(tr);
  }
}

function renderRuntime() {
  const pages = state.data?.pages || [];
  const runtime = state.data?.runtime || [];
  const grid = $('runtimeGrid');
  grid.innerHTML = '';
  for (const page of pages) {
    const row = runtime.find(item => item.page_id === page.page_id) || { page_id: page.page_id, mode: 'OBSERVE', minimum_apply_confidence: 0.78, recent_context_minutes: 60, use_ad_mapping: true, use_recent_context: true, use_slide_mapping: true };
    const div = document.createElement('div');
    div.className = 'runtime-card';
    div.innerHTML = `<h3 style="margin-top:0">${esc(page.page_name || page.page_id)}</h3><div class="id">${esc(page.page_id)}</div><div class="grid" style="margin-top:12px"><div class="field"><label>Chế độ</label><select id="rt_mode_${page.page_id}"><option ${row.mode === 'OFF' ? 'selected' : ''}>OFF</option><option ${row.mode === 'OBSERVE' ? 'selected' : ''}>OBSERVE</option><option ${row.mode === 'ACTIVE' ? 'selected' : ''}>ACTIVE</option></select></div><div class="field"><label>Ngưỡng áp dụng</label><input id="rt_conf_${page.page_id}" type="number" min="0" max="1" step="0.01" value="${row.minimum_apply_confidence ?? 0.78}"></div><div class="field"><label>Giữ ngữ cảnh (phút)</label><input id="rt_min_${page.page_id}" type="number" min="5" value="${row.recent_context_minutes || 60}"></div><div class="field"><label><input id="rt_ad_${page.page_id}" type="checkbox" ${row.use_ad_mapping !== false ? 'checked' : ''}> Dùng Ads Mapping</label><label><input id="rt_ctx_${page.page_id}" type="checkbox" ${row.use_recent_context !== false ? 'checked' : ''}> Dùng ngữ cảnh</label><label><input id="rt_slide_${page.page_id}" type="checkbox" ${row.use_slide_mapping !== false ? 'checked' : ''}> Dùng Slide Mapping</label></div></div><div class="form-actions"><button class="primary" onclick="saveRuntime('${page.page_id}')">Lưu Page này</button></div>`;
    grid.appendChild(div);
  }
}

function renderLog() {
  const rows = state.data?.change_log || [];
  const body = $('logBody');
  body.innerHTML = rows.length ? '' : '<tr><td colspan="4" class="empty">Chưa có nhật ký Mapping.</td></tr>';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtDate(row.created_at)}</td><td>${esc(row.action || '-')}</td><td>${esc(row.asset_type || '-')}<div class="id">${esc(row.asset_id || '')}</div></td><td><div class="small">${esc(JSON.stringify(row.details || row.after_data || row.metadata || {}))}</div></td>`;
    body.appendChild(tr);
  }
}

function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

function openMapping(row) {
  const mapping = row.mapping || row || {};
  $('mappingTitle').textContent = mapping.ad_id ? 'Sửa Mapping QC' : 'Thêm Mapping QC';
  $('m_ad_id').value = mapping.ad_id || row.ad_id || '';
  $('m_ad_name').value = mapping.ad_name || row.ad_title || '';
  $('m_account_label').value = mapping.ad_account_name || row.ad_account_name || mapping.ad_account_id || row.ad_account_id || '';
  $('m_page_name').value = row.page_name || row.page_id || '';
  $('m_campaign_name').value = mapping.campaign_name || row.campaign_name || '';
  $('m_adset_name').value = mapping.adset_name || row.adset_name || '';
  $('m_group').value = mapping.product_group === 'general' ? '' : (mapping.product_group || '');
  $('m_catalog').value = mapping.product_item_key || '';
  $('m_notes').value = mapping.notes || '';
  $('m_active').checked = mapping.is_active !== false;
  $('m_campaign_id').value = mapping.campaign_id || row.campaign_id || '';
  $('m_adset_id').value = mapping.adset_id || row.adset_id || '';
  $('m_ad_account_id').value = mapping.ad_account_id || row.ad_account_id || '';
  $('m_ad_account_name').value = mapping.ad_account_name || row.ad_account_name || '';
  setFolderSelection('m_folders', mapping.resolved_folder_ids || mapping.selected_folders || mapping.drive_folders || []);
  openModal('mappingModal');
  loadDriveTree(false).catch(error => status(`Đang dùng danh sách đã đồng bộ vì chưa tải được cây Drive: ${error.message}`, true));
}

function suggestFoldersFromCatalog() {
  const key = $('m_catalog').value;
  if (!key) return;
  const catalog = state.catalogs.find(row => row.catalog_key === key);
  const selection = folderSelection('m_folders');
  if (catalog?.drive_folder_id) selection.add(String(catalog.drive_folder_id));
  for (const folder of state.folders) if ((folder.catalogs || []).includes(key)) selection.add(String(folder.folder_id));
  renderFolderPicker('m_folders');
}

async function saveMapping(event) {
  event.preventDefault();
  const folders = selectedFolderIds('m_folders');
  if (!$('m_group').value && !$('m_catalog').value && !folders.length) {
    status('Hãy chọn nhóm, sản phẩm hoặc ít nhất một thư mục Drive.', true);
    return;
  }
  busy(true);
  try {
    const body = {
      ad_id: $('m_ad_id').value.trim(),
      ad_name: $('m_ad_name').value.trim(),
      campaign_id: $('m_campaign_id').value,
      campaign_name: $('m_campaign_name').value.trim(),
      adset_id: $('m_adset_id').value,
      adset_name: $('m_adset_name').value.trim(),
      ad_account_id: $('m_ad_account_id').value,
      ad_account_name: $('m_ad_account_name').value,
      product_group: $('m_group').value,
      product_item_key: $('m_catalog').value,
      selected_folders: folders,
      notes: $('m_notes').value.trim(),
      is_active: $('m_active').checked,
      enabled: $('m_active').checked
    };
    await api('/api/v8-mapping-center/ad-mapping', { method: 'POST', body: JSON.stringify(body) });
    closeModal('mappingModal');
    await loadAll(false);
    status(`Đã lưu Mapping QC với ${folders.length} thư mục Drive.`);
  } catch (error) {
    status(error.message, true);
  } finally {
    busy(false);
  }
}

async function disableMapping(adId) {
  if (!confirm('Tắt Mapping này? QC sẽ quay về nhận diện theo lời khách/ngữ cảnh.')) return;
  busy(true);
  try {
    await api('/api/v8-mapping-center/ad-mapping/disable', { method: 'POST', body: JSON.stringify({ ad_id: adId }) });
    await loadAll(false);
    status('Đã tắt Mapping.');
  } catch (error) {
    status(error.message, true);
  } finally {
    busy(false);
  }
}

function openSlideMapping(mapping) {
  $('sm_id').value = mapping.id || '';
  $('sm_product').value = mapping.product_key || '';
  $('sm_name').value = mapping.product_name || '';
  $('sm_page').value = mapping.page_id || '';
  $('sm_priority').value = mapping.priority || 100;
  $('sm_active').checked = mapping.is_active !== false;
  $('sm_sync').checked = !mapping.id || !mapping.last_synced_at || ['idle', 'requested', 'error'].includes(String(mapping.sync_status || 'idle').toLowerCase());
  $('sm_note').value = mapping.note || '';
  const ids = [...(mapping.drive_folder_ids || [])];
  if (!ids.length && mapping.drive_folder_id) ids.push(mapping.drive_folder_id);
  setFolderSelection('sm_folders', ids);
  openModal('slideModal');
  loadDriveTree(false).catch(error => status(`Đang dùng danh sách đã đồng bộ vì chưa tải được cây Drive: ${error.message}`, true));
}

function fillSlideProductName() {
  const catalog = state.catalogs.find(row => row.catalog_key === $('sm_product').value);
  if (catalog && !$('sm_name').value) $('sm_name').value = catalog.catalog_name;
}

async function saveSlideMapping(event) {
  event.preventDefault();
  busy(true);
  try {
    const ids = selectedFolderIds('sm_folders');
    if (!ids.length) throw new Error('Hãy chọn ít nhất một thư mục Drive.');
    const folderValues = selectedFolderValues('sm_folders');
    const catalog = state.catalogs.find(row => row.catalog_key === $('sm_product').value);
    const first = state.folders.find(row => row.folder_id === ids[0]);
    const requestSync = $('sm_sync').checked;
    const response = await api('/api/v8-mapping-center/slide-mapping', {
      method: 'POST',
      body: JSON.stringify({
        id: $('sm_id').value || null,
        product_key: $('sm_product').value,
        product_name: $('sm_name').value || catalog?.catalog_name,
        page_id: $('sm_page').value || null,
        drive_folder_ids: folderValues,
        drive_folder_id: ids[0] || null,
        drive_folder_url: first?.folder_url || '',
        priority: Number($('sm_priority').value || 100),
        is_active: $('sm_active').checked,
        request_sync: requestSync,
        note: $('sm_note').value
      })
    });
    let syncResult = null;
    let syncError = null;
    if (requestSync && response.saved?.id) {
      try {
        syncResult = await api('/api/slide-manager/drive/sync', {
          method: 'POST',
          body: JSON.stringify({ mapping_id: response.saved.id })
        });
      } catch (error) {
        syncError = error;
      }
    }
    closeModal('slideModal');
    await loadAll(false);
    if (syncError) status(`Đã lưu Mapping nhưng đồng bộ Drive lỗi: ${syncError.message}`, true);
    else if (syncResult) status(`Đã lưu và quét ${syncResult.folders_scanned || 0} thư mục, đồng bộ ${syncResult.synced || 0} ảnh cho Bot.`);
    else status(`Đã lưu Mapping sản phẩm với ${ids.length} thư mục Drive.`);
  } catch (error) {
    status(error.message, true);
  } finally {
    busy(false);
  }
}

async function syncSlideMapping(mappingId) {
  busy(true);
  try {
    const result = await api('/api/slide-manager/drive/sync', {
      method: 'POST',
      body: JSON.stringify({ mapping_id: mappingId })
    });
    await loadAll(false);
    status(`Đã quét ${result.folders_scanned || 0} thư mục và đồng bộ ${result.synced || 0} ảnh cho Bot.`);
  } catch (error) {
    await loadAll(false).catch(() => {});
    status(`Đồng bộ Drive lỗi: ${error.message}`, true);
  } finally {
    busy(false);
  }
}

async function saveRuntime(pageId) {
  busy(true);
  try {
    await api('/api/v8-mapping-center/runtime', {
      method: 'POST',
      body: JSON.stringify({
        page_id: pageId,
        mode: $('rt_mode_' + pageId).value,
        minimum_apply_confidence: Number($('rt_conf_' + pageId).value),
        recent_context_minutes: Number($('rt_min_' + pageId).value),
        use_ad_mapping: $('rt_ad_' + pageId).checked,
        use_recent_context: $('rt_ctx_' + pageId).checked,
        use_slide_mapping: $('rt_slide_' + pageId).checked
      })
    });
    await loadAll(false);
    status('Đã lưu chế độ Mapping cho Page.');
  } catch (error) {
    status(error.message, true);
  } finally {
    busy(false);
  }
}

async function runTest() {
  busy(true);
  try {
    const data = await api('/api/v8-mapping-center/test', {
      method: 'POST',
      body: JSON.stringify({
        page_id: $('testPage').value,
        ad_id: $('testAdId').value.trim(),
        ad_title: $('testAdTitle').value.trim(),
        message_text: $('testText').value.trim()
      })
    });
    const result = data.result || {};
    $('testSummary').innerHTML = `<div class="notice"><div class="grid3"><div><b>Kết quả</b><div>${esc(result.status || '-')}</div></div><div><b>Nguồn</b><div>${esc(result.source || '-')}</div></div><div><b>Độ tin cậy</b><div>${esc(result.confidence ?? '-')}</div></div><div><b>Nhóm</b><div>${esc(result.group_key || '-')}</div></div><div><b>Catalog</b><div>${esc(result.catalog_key || (result.status === 'folder_scope' ? 'QC tổng hợp theo thư mục' : '-'))}</div></div><div><b>Áp dụng runtime</b><div>${result.apply_to_runtime ? '<span class="badge ok">Có</span>' : '<span class="badge warn">Không</span>'}</div></div><div><b>Mâu thuẫn</b><div>${result.conflict ? 'Có — lời khách thắng' : 'Không'}</div></div><div><b>Cần hỏi lại</b><div>${result.needs_clarification ? 'Có' : 'Không'}</div></div><div><b>Số ảnh</b><div>${result.slide_asset_count || 0}</div></div></div></div>`;
    $('testAssets').innerHTML = (data.preview_assets || []).map(asset => `<div class="asset"><img src="${esc(asset.delivery_url || asset.file_url || '')}" alt=""><div class="small" style="margin-top:6px">${esc(asset.file_name || 'Ảnh')}</div><div class="small muted">${esc(asset.catalog_key || '')}</div></div>`).join('');
    $('testRaw').style.display = 'block';
    $('testRaw').textContent = JSON.stringify(data, null, 2);
    status('Đã chạy test, không gửi khách thật.');
  } catch (error) {
    status(error.message, true);
  } finally {
    busy(false);
  }
}

function quickTest(row) {
  $('testPage').value = row.page_id || '';
  $('testAdId').value = row.ad_id || '';
  $('testAdTitle').value = row.ad_title || '';
  $('testText').value = 'gửi mẫu cho tôi';
  showTab('test');
  runTest();
}

function testCurrentMappingForm() {
  const page = (state.currentAds.find(row => row.ad_id === $('m_ad_id').value) || {}).page_id || $('testPage').value;
  $('testPage').value = page;
  $('testAdId').value = $('m_ad_id').value;
  $('testAdTitle').value = $('m_ad_name').value;
  $('testText').value = 'gửi mẫu cho tôi';
  closeModal('mappingModal');
  showTab('test');
  runTest();
}

window.addEventListener('click', event => {
  if (event.target.classList.contains('modal')) event.target.classList.remove('open');
});
