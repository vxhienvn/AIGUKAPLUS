function mappingFolderIds(mapping) {
  const preferred = Array.isArray(mapping?.resolved_folder_ids) && mapping.resolved_folder_ids.length
    ? mapping.resolved_folder_ids
    : (Array.isArray(mapping?.selected_folders) && mapping.selected_folders.length ? mapping.selected_folders : (mapping?.drive_folders || []));
  return [...new Set((Array.isArray(preferred) ? preferred : []).map(value => String(typeof value === 'string' ? value : (value?.id || value?.folder_id || value?.drive_folder_id || ''))).filter(Boolean))];
}

function statusDotHtml(value, customLabel = '') {
  const statusValue = String(value || '').trim().toUpperCase();
  const active = new Set(['ACTIVE', 'SUCCESS', 'CONNECTED', 'CATALOG']);
  const waiting = new Set(['PAUSED', 'AD_PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PENDING_REVIEW', 'IN_PROCESS', 'PREAPPROVED', 'REQUESTED', 'IDLE', 'PENDING_BILLING_INFO', 'ACCOUNT_PENDING_RISK_REVIEW', 'ACCOUNT_PENDING_SETTLEMENT', 'ACCOUNT_IN_GRACE_PERIOD', 'ACCOUNT_PENDING_CLOSURE']);
  const stopped = new Set(['OFF', 'DISABLED', 'DISAPPROVED', 'WITH_ISSUES', 'ERROR', 'FAILED', 'DELETED', 'ARCHIVED', 'ACCOUNT_DISABLED', 'ACCOUNT_UNSETTLED', 'ACCOUNT_CLOSED', 'ACCOUNT_INACTIVE']);
  const tone = active.has(statusValue) ? 'live' : (waiting.has(statusValue) ? 'waiting' : (stopped.has(statusValue) ? 'stopped' : 'unknown'));
  const labels = {
    ACTIVE: 'Đang hoạt động',
    SUCCESS: 'Đã đồng bộ',
    CONNECTED: 'Đã kết nối',
    CATALOG: 'Theo catalog',
    PAUSED: 'Đang tạm dừng',
    AD_PAUSED: 'QC đang tạm dừng',
    CAMPAIGN_PAUSED: 'Chiến dịch đang tạm dừng',
    ADSET_PAUSED: 'Nhóm quảng cáo đang tạm dừng',
    PENDING_REVIEW: 'Đang chờ duyệt',
    IN_PROCESS: 'Đang xử lý',
    PREAPPROVED: 'Đã duyệt trước',
    REQUESTED: 'Đang chờ đồng bộ',
    IDLE: 'Chưa đồng bộ',
    OFF: 'Đã tắt',
    DISABLED: 'Đã tắt',
    DISAPPROVED: 'Không được duyệt',
    WITH_ISSUES: 'Có lỗi',
    PENDING_BILLING_INFO: 'Đang chờ thông tin thanh toán',
    DELETED: 'Đã xóa trên Meta',
    ARCHIVED: 'Đã lưu trữ trên Meta',
    ACCOUNT_DISABLED: 'Tài khoản quảng cáo đã bị vô hiệu hóa',
    ACCOUNT_UNSETTLED: 'Tài khoản quảng cáo chưa thanh toán',
    ACCOUNT_CLOSED: 'Tài khoản quảng cáo đã đóng',
    ACCOUNT_INACTIVE: 'Tài khoản quảng cáo không hoạt động',
    ACCOUNT_PENDING_RISK_REVIEW: 'Tài khoản quảng cáo đang chờ kiểm tra rủi ro',
    ACCOUNT_PENDING_SETTLEMENT: 'Tài khoản quảng cáo đang chờ thanh toán',
    ACCOUNT_IN_GRACE_PERIOD: 'Tài khoản quảng cáo đang trong thời gian gia hạn',
    ACCOUNT_PENDING_CLOSURE: 'Tài khoản quảng cáo đang chờ đóng',
    ERROR: 'Có lỗi',
    FAILED: 'Thất bại',
    HISTORICAL: 'Chỉ có trong lịch sử khách hoặc Mapping cũ',
    UNKNOWN: 'Meta chưa trả trạng thái'
  };
  const label = customLabel || labels[statusValue] || 'Chưa rõ trạng thái';
  return `<span class="status-dot ${tone}" title="${esc(label)}" aria-label="${esc(label)}"></span>`;
}

function statusRank(value) {
  const statusValue = String(value || '').trim().toUpperCase();
  if (statusValue === 'ACTIVE') return 0;
  if (['PENDING_REVIEW', 'IN_PROCESS', 'PREAPPROVED', 'ACCOUNT_PENDING_RISK_REVIEW', 'ACCOUNT_PENDING_SETTLEMENT', 'ACCOUNT_IN_GRACE_PERIOD', 'ACCOUNT_PENDING_CLOSURE'].includes(statusValue)) return 1;
  if (['PAUSED', 'AD_PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PENDING_BILLING_INFO'].includes(statusValue)) return 2;
  if (['WITH_ISSUES', 'DISAPPROVED', 'ERROR', 'FAILED', 'OFF', 'DISABLED', 'DELETED', 'ARCHIVED', 'ACCOUNT_DISABLED', 'ACCOUNT_UNSETTLED', 'ACCOUNT_CLOSED', 'ACCOUNT_INACTIVE'].includes(statusValue)) return 3;
  return 4;
}

function updateStatusSortButton(kind) {
  const key = kind === 'mapping' ? 'mappingStatusSort' : 'currentStatusSort';
  const button = $(key);
  if (!button) return;
  const direction = state[key];
  button.textContent = `Trạng thái ${direction === 'asc' ? '↑' : (direction === 'desc' ? '↓' : '↕')}`;
  button.classList.toggle('active', Boolean(direction));
  button.setAttribute('aria-pressed', String(Boolean(direction)));
}

function toggleStatusSort(kind) {
  const key = kind === 'mapping' ? 'mappingStatusSort' : 'currentStatusSort';
  state[key] = state[key] === 'asc' ? 'desc' : 'asc';
  if (kind === 'mapping') renderMappings();
  else renderCurrent();
}

function sortRowsByStatus(rows, direction, statusFn) {
  if (!direction) return rows;
  const multiplier = direction === 'desc' ? -1 : 1;
  return rows.sort((a, b) => multiplier * (statusRank(statusFn(a)) - statusRank(statusFn(b))));
}

function compactFolderHtml(ids, detailBuilder) {
  const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
  if (!uniqueIds.length) return '';
  const details = uniqueIds.map(id => detailBuilder(id));
  if (uniqueIds.length === 1) return details[0];
  const firstName = folderName(uniqueIds[0]);
  return `<details class="folder-disclosure" ontoggle="this.querySelector('.folder-toggle-label').textContent=this.open?'Thu gọn':'Mở rộng'"><summary><span class="folder-summary-label">📁 ${esc(firstName)} <span class="small muted">+${uniqueIds.length - 1}</span></span><span class="folder-toggle-label">Mở rộng</span></summary><div class="folder-details">${details.join('')}</div></details>`;
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
  if (mapping.is_active === false || mapping.enabled === false) {
    return `<span class="badge bad">Mapping đã tắt</span><div style="margin-top:5px"><b>${esc(scope.title)}</b></div><div class="small muted">Bot không sử dụng nguồn ảnh này</div>`;
  }
  if (!mappingHasUsableScope(mapping)) {
    return `<span class="badge warn">Thiếu nguồn ảnh</span><div style="margin-top:5px"><b>${esc(scope.title)}</b></div><div class="small warn-text">Cần chọn nhóm sản phẩm, catalog hoặc thư mục Drive</div>`;
  }
  return `<span class="badge ok">Đã Mapping</span><div style="margin-top:5px"><b>${esc(scope.title)}</b></div><div class="small muted">${esc(scope.detail)}</div>`;
}

function currentRows() {
  let rows = [...state.currentAds];
  const businessId = $('currentBusiness').value;
  const accountId = $('currentAccount').value;
  const metaState = $('currentMetaState')?.value || 'active';
  const mappingState = $('currentState').value;
  const sort = $('currentSort').value;
  rows = rows.filter(row =>
    (!businessId || String(row.business_id || '') === businessId) &&
    (!accountId || String(row.ad_account_id || row.mapping?.ad_account_id || '') === accountId) &&
    (metaState === 'all' ||
      (metaState === 'active' && isActiveMetaAd(row)) ||
      (metaState === 'inactive' && row.meta_seen && !isActiveMetaAd(row)) ||
      (metaState === 'all-meta' && row.meta_seen) ||
      (metaState === 'history' && !row.meta_seen)) &&
    (!mappingState || (mappingState === 'mapped' ? row.mapped : !row.mapped))
  );
  if (sort === 'customers') rows.sort((a, b) => (b.customers || 0) - (a.customers || 0));
  else if (sort === 'unmapped') rows.sort((a, b) => Number(a.mapped) - Number(b.mapped) || new Date(b.last_referral || 0) - new Date(a.last_referral || 0));
  else rows.sort((a, b) => new Date(b.last_referral || 0) - new Date(a.last_referral || 0));
  sortRowsByStatus(rows, state.currentStatusSort, metaEffectiveStatus);
  return rows;
}

function folderListHtml(mapping) {
  if (!mapping) {
    return '<span class="badge bad">Chưa có nguồn Drive</span><div class="small muted">QC chưa tạo Mapping; bấm <b>Mapping ngay</b> để chọn nguồn ảnh.</div>';
  }
  const ids = mappingFolderIds(mapping);
  if (mapping.is_active === false || mapping.enabled === false) {
    return '<span class="badge bad">Mapping đã tắt</span><div class="small muted">Bot không sử dụng nguồn Drive đã lưu.</div>';
  }
  if (!ids.length && !mappingHasUsableScope(mapping)) {
    return '<span class="badge warn">Chưa chọn thư mục Drive</span><div class="small warn-text">QC cũ đã có bản ghi nhưng Bot chưa có nguồn ảnh riêng.</div>';
  }
  if (!ids.length) {
    const scope = mappingScope(mapping);
    return `<span class="badge info">Theo phạm vi sản phẩm</span><div class="small muted">${esc(scope.title)}</div>`;
  }
  const warning = mapping?.folder_sync_status === 'partial' ? '<div class="badge warn">Có đường dẫn cũ chưa đối chiếu được</div>' : '';
  return compactFolderHtml(ids, id => `<div class="small folder-detail-row">📁 ${esc(folderName(id))}</div>`) + warning;
}

function renderCurrent() {
  const rows = currentRows();
  const campaigns = new Set(rows.map(row => String(row.campaign_id || row.campaign_name || '')).filter(Boolean));
  const adsets = new Set(rows.map(row => String(row.adset_id || row.adset_name || '')).filter(Boolean));
  const metaState = $('currentMetaState')?.value || 'active';
  const suffix = metaState === 'active' ? ' đang hoạt động' : '';
  $('currentTableSummary').textContent = `${campaigns.size} chiến dịch · ${adsets.size} nhóm quảng cáo · ${rows.length} QC${suffix}`;
  updateStatusSortButton('current');
  const body = $('currentBody');
  body.innerHTML = rows.length ? '' : '<tr><td colspan="5" class="empty">Không có QC phù hợp.</td></tr>';
  for (const row of rows) {
    const campaign = row.campaign_name || row.mapping?.campaign_name || 'Chưa đồng bộ tên chiến dịch';
    const adset = row.adset_name || row.mapping?.adset_name || 'Chưa đồng bộ tên nhóm quảng cáo';
    const adName = row.ad_title || row.ad_name || row.mapping?.ad_name || 'Chưa đồng bộ tên quảng cáo';
    const effectiveStatus = metaEffectiveStatus(row);
    const statusDot = statusDotHtml(effectiveStatus);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><div class="status-title">${statusDot}<b>${esc(campaign)}</b></div><div class="status-subtitle">${statusDot}<span>${esc(adset)}</span></div><div class="current-ad-name"><span>QC:</span> <b>${esc(adName)}</b></div><div class="small muted">Lần cuối: ${fmtDate(row.last_referral)}</div></td><td><b>${row.customers || 0}</b> khách<div class="small muted">${row.referrals || 0} lượt · ${row.contacts || 0} có liên hệ</div></td><td>${mappingLabel(row.mapping)}</td><td>${folderListHtml(row.mapping)}</td><td><div class="row-actions"><button class="primary" onclick='openMapping(${JSON.stringify(row).replace(/'/g, "&#39;")})'>${row.mapped ? 'Sửa' : 'Mapping ngay'}</button><button onclick='quickTest(${JSON.stringify(row).replace(/'/g, "&#39;")})'>Test</button></div></td>`;
    body.appendChild(tr);
  }
}

function mappingCurrentInfo(adId) { return state.currentAds.find(row => String(row.ad_id) === String(adId)); }

function mappingAccountContext(mapping, current = mappingCurrentInfo(mapping?.ad_id)) {
  const accountId = String(current?.ad_account_id || mapping?.ad_account_id || '');
  const account = state.adAccounts.find(row => String(row.ad_account_id || '') === accountId);
  return {
    accountId,
    accountName: current?.ad_account_name || mapping?.ad_account_name || account?.ad_account_name || '',
    businessId: String(current?.business_id || account?.business_id || ''),
    businessName: current?.business_name || account?.business_name || ''
  };
}

function hasRecentReferral(row) {
  return Boolean(row?.last_referral) || Number(row?.referrals || 0) > 0;
}

function renderMappings() {
  const query = $('mappingSearch').value.toLocaleLowerCase('vi-VN').trim();
  const mode = $('mappingAge').value;
  const businessId = $('mappingBusiness').value;
  const accountId = $('mappingAccount').value;
  let rows = state.mappings.filter(mapping => {
    const current = mappingCurrentInfo(mapping.ad_id);
    const account = mappingAccountContext(mapping, current);
    const searchable = [mapping.ad_id, mapping.ad_name, mapping.campaign_name, mapping.adset_name, account.accountId, account.accountName, account.businessName, mapping.product_group, mapping.product_item_key, mapping.drive_folder, mapping.notes].join(' ').toLocaleLowerCase('vi-VN');
    return (!businessId || account.businessId === businessId) &&
      (!accountId || account.accountId === accountId) &&
      (!query || searchable.includes(query));
  });
  rows = rows.filter(mapping => {
    const current = mappingCurrentInfo(mapping.ad_id);
    const recent = hasRecentReferral(current);
    return mode === 'all' || (mode === 'current' ? recent : !recent);
  });
  sortRowsByStatus(rows, state.mappingStatusSort, mapping => {
    if (mapping.is_active === false) return 'OFF';
    return metaEffectiveStatus(mappingCurrentInfo(mapping.ad_id));
  });
  updateStatusSortButton('mapping');
  const body = $('mappingBody');
  body.innerHTML = rows.length ? '' : '<tr><td colspan="6" class="empty">Không có Mapping phù hợp.</td></tr>';
  for (const mapping of rows) {
    const current = mappingCurrentInfo(mapping.ad_id);
    const adName = current?.ad_title || current?.ad_name || mapping.ad_name || 'QC chưa có tên';
    const campaign = mapping.campaign_name || current?.campaign_name || 'Chưa đồng bộ tên chiến dịch';
    const adset = mapping.adset_name || current?.adset_name || 'Chưa đồng bộ tên nhóm quảng cáo';
    const effectiveStatus = mapping.is_active === false ? 'OFF' : metaEffectiveStatus(current);
    const statusDot = statusDotHtml(effectiveStatus);
    const scope = mappingScope(mapping);
    const recent = hasRecentReferral(current);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><div class="status-title">${statusDot}<b>${esc(adName)}</b></div><div class="status-subtitle"><span>Chiến dịch: ${esc(campaign)}</span></div><div class="status-subtitle"><span>Nhóm: ${esc(adset)}</span></div>${mapping.is_active === false ? '<span class="badge bad">Đã tắt</span>' : ''}</td><td><b>${esc(scope.title)}</b><div class="small muted">${esc(scope.detail)}</div></td><td>${folderListHtml(mapping)}</td><td>${recent ? `<span class="badge ok">Đang có khách</span><div class="small">${current.customers || 0} khách · ${fmtDate(current.last_referral)}</div>` : '<span class="badge warn">Không phát sinh gần đây</span>'}</td><td>${fmtDate(mapping.updated_at)}</td><td><div class="row-actions"><button onclick='openMapping(${JSON.stringify({ ...current, mapping }).replace(/'/g, "&#39;")})'>Sửa</button>${mapping.is_active !== false ? `<button class="danger" onclick="disableMapping('${esc(mapping.ad_id)}')">Tắt</button>` : ''}</div></td>`;
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
  if (statusValue === 'error') return `<span class="badge bad">Đồng bộ lỗi</span><div class="small warn-text">${esc(mapping.sync_error || 'Bấm Đồng bộ tất cả để thử lại')}</div>`;
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
      : `<button onclick='openSlideMapping(${JSON.stringify(mapping).replace(/'/g, "&#39;")})'>Sửa</button>`;
    const productStatus = mapping.is_active === false ? 'OFF' : (mapping._catalog_only ? 'CATALOG' : (mapping.sync_status || 'IDLE'));
    const productStatusLabel = mapping.is_active === false ? 'Mapping đã tắt' : (mapping._catalog_only ? 'Đang dùng catalog' : '');
    const folderHtml = ids.length
      ? compactFolderHtml(ids, id => {
          const folder = state.folders.find(row => String(row.folder_id) === String(id));
          const total = Number(folder?.images ?? folder?.total_images ?? folder?.direct_images ?? 0);
          const direct = Number(folder?.direct_images ?? total);
          return `<div class="folder-detail-row">📁 ${esc(folder?.folder_name || id)} <span class="small muted">(${total} ảnh tổng · ${direct} trực tiếp)</span></div>`;
        })
      : '<span class="badge bad">Chưa gán thư mục</span>';
    tr.innerHTML = `<td><div class="status-title">${statusDotHtml(productStatus, productStatusLabel)}<b>${esc(mapping.product_name || catalog?.catalog_name || mapping.product_key)}</b></div><div class="id">${esc(mapping.product_key)}</div><div class="small muted">${esc(mapping.folder_path || catalog?.folder_path || '')}</div></td><td>${esc(mapping.page_id || 'Tất cả Page')}</td><td>${folderHtml}</td><td><b>${shownCount}</b>${shownCount ? '<span class="badge ok" style="margin-left:6px">Có ảnh</span>' : '<span class="badge bad" style="margin-left:6px">Thiếu ảnh</span>'}${countDetail}</td><td>${syncStatusHtml(mapping, syncedCount)}</td><td>${action}</td>`;
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

function syncAllUi(snapshot = {}) {
  const button = $('syncAllProducts');
  const detail = $('syncAllProductsStatus');
  const running = Boolean(snapshot.running);
  const total = Number(snapshot.total || 0);
  const completed = Number(snapshot.completed || 0);
  if (button) {
    button.disabled = running;
    button.textContent = running
      ? (total ? `Đang đồng bộ ${completed}/${total}` : 'Đang chuẩn bị...')
      : 'Đồng bộ tất cả';
  }
  if (!detail) return;
  if (running) {
    detail.textContent = total
      ? `Đang quét tuần tự ${completed}/${total} mapping; đã đồng bộ ${Number(snapshot.images_synced || 0)} ảnh.`
      : 'Đang kiểm tra các mapping cần đồng bộ...';
  } else if (snapshot.finished_at) {
    const errors = Array.isArray(snapshot.errors) ? snapshot.errors.length : 0;
    detail.textContent = total
      ? `Hoàn tất ${Number(snapshot.mappings_synced || 0)}/${total} mapping, ${Number(snapshot.images_synced || 0)} ảnh${errors ? `, ${errors} lỗi` : ''}.`
      : `Không cần quét lại; ${Number(snapshot.skipped || 0)} mapping vẫn còn mới.`;
  }
}

async function syncAllSlideMappings(force = false) {
  if (state.syncAllRunning) return;
  state.syncAllRunning = true;
  const pollToken = ++state.syncAllPollToken;
  let snapshot = { running: true, total: 0, completed: 0, images_synced: 0 };
  syncAllUi(snapshot);
  try {
    snapshot = await api('/api/slide-manager/drive/sync-all', {
      method: 'POST',
      body: JSON.stringify({ force: Boolean(force), stale_after_minutes: 15 })
    });
    syncAllUi(snapshot);
    while (snapshot.running && pollToken === state.syncAllPollToken) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      snapshot = await api('/api/slide-manager/drive/sync-all/status');
      syncAllUi(snapshot);
    }
    if (pollToken !== state.syncAllPollToken) return;
    const errors = Array.isArray(snapshot.errors) ? snapshot.errors.length : 0;
    await loadAll(false);
    if (errors) {
      status(`Đồng bộ hoàn tất nhưng có ${errors} mapping lỗi. Xem trạng thái từng dòng để xử lý.`, true);
    } else if (Number(snapshot.mappings_synced || 0) > 0) {
      status(`Đã tự động đồng bộ ${snapshot.mappings_synced} mapping và ${snapshot.images_synced || 0} ảnh từ Drive.`);
    } else if (force) {
      status('Không có mapping Drive hợp lệ cần đồng bộ.', true);
    }
  } catch (error) {
    syncAllUi({ running: false });
    status(`Đồng bộ tất cả lỗi: ${error.message}`, true);
  } finally {
    if (pollToken === state.syncAllPollToken) {
      state.syncAllRunning = false;
      syncAllUi({ ...snapshot, running: false });
    }
  }
}

function maybeAutoSyncAllSlideMappings() {
  if (state.productAutoSyncStarted) return;
  state.productAutoSyncStarted = true;
  syncAllSlideMappings(false);
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
