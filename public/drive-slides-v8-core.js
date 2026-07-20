const state = {
  data: null,
  currentAds: [],
  metaAds: [],
  metaError: '',
  mappings: [],
  catalogs: [],
  groups: [],
  folders: [],
  slideMappings: [],
  adAccounts: [],
  businesses: [],
  driveTree: [],
  driveTreeLoaded: false,
  driveTreePromise: null,
  folderSelections: { m_folders: new Set(), sm_folders: new Set() }
};

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[match]));

function status(message, error = false) {
  const element = $('statusbar');
  element.textContent = message;
  element.className = `statusbar show${error ? ' error' : ''}`;
  clearTimeout(status.timer);
  status.timer = setTimeout(() => { element.className = 'statusbar'; }, 5000);
}

function busy(on) { $('progress').hidden = !on; }

function fmtDate(value) {
  if (!value) return '-';
  try { return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
  catch (_) { return value; }
}

function showTab(id, button) {
  document.querySelectorAll('.panel').forEach(element => element.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(element => element.classList.remove('active'));
  $('p-' + id)?.classList.add('active');
  (button || document.querySelector(`[data-tab="${id}"]`))?.classList.add('active');
}

function adminHeaders() {
  const key = localStorage.getItem('aiguka_mapping_admin_key') || '';
  return key ? { 'x-admin-key': key } : {};
}

async function api(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...adminHeaders(), ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { error: raw }; }
  if (response.status === 401 && data.requires_admin_key) {
    const key = prompt('Nhập khóa quản trị Mapping (chỉ hỏi một lần trên trình duyệt này):');
    if (key) {
      localStorage.setItem('aiguka_mapping_admin_key', key);
      return api(url, options);
    }
  }
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function mergeAccounts(rows = []) {
  const accounts = new Map(state.adAccounts.map(row => [String(row.ad_account_id || ''), row]));
  for (const row of rows) {
    const id = String(row.ad_account_id || row.account_id || '').replace(/^act_/, '').trim();
    if (!id) continue;
    const current = accounts.get(id) || { ad_account_id: id };
    accounts.set(id, {
      ...current,
      ...row,
      ad_account_id: id,
      ad_account_name: row.ad_account_name || row.name || current.ad_account_name || id,
      business_id: String(row.business_id || row.business?.id || current.business_id || ''),
      business_name: row.business_name || row.business?.name || current.business_name || ''
    });
  }
  state.adAccounts = [...accounts.values()].sort((a, b) => String(a.ad_account_name).localeCompare(String(b.ad_account_name), 'vi'));
}

function mergeBusinesses(rows = []) {
  const businesses = new Map(state.businesses.map(row => [String(row.business_id || row.id || ''), row]));
  for (const row of rows) {
    const id = String(row.business_id || row.id || '').trim();
    if (!id) continue;
    businesses.set(id, {
      ...businesses.get(id),
      ...row,
      business_id: id,
      business_name: row.business_name || row.name || businesses.get(id)?.business_name || id
    });
  }
  for (const account of state.adAccounts) {
    if (account.business_id && !businesses.has(account.business_id)) {
      businesses.set(account.business_id, { business_id: account.business_id, business_name: account.business_name || account.business_id });
    }
  }
  state.businesses = [...businesses.values()].sort((a, b) => String(a.business_name).localeCompare(String(b.business_name), 'vi'));
}

function mappingHasUsableScope(mapping) {
  if (!mapping || mapping.is_active === false || mapping.enabled === false) return false;
  const productItem = String(mapping.product_item_key || '').trim();
  const productGroup = String(mapping.product_group || '').trim();
  const folders = Array.isArray(mapping.resolved_folder_ids) && mapping.resolved_folder_ids.length
    ? mapping.resolved_folder_ids
    : (Array.isArray(mapping.selected_folders) && mapping.selected_folders.length ? mapping.selected_folders : (mapping.drive_folders || []));
  return Boolean(productItem || (productGroup && productGroup !== 'general') || (Array.isArray(folders) && folders.length));
}

function mergeMetaAds() {
  const ads = new Map(state.currentAds.map(row => [String(row.ad_id), row]));
  const pages = new Map((state.data?.pages || []).map(row => [String(row.page_id), row.page_name || row.page_id]));
  const accounts = new Map(state.adAccounts.map(row => [String(row.ad_account_id), row]));
  for (const row of state.metaAds) {
    const id = String(row.ad_id || '');
    if (!id) continue;
    const current = ads.get(id) || {
      page_id: row.page_id || '',
      page_name: row.page_name || pages.get(String(row.page_id || '')) || '',
      ad_id: id,
      ad_title: row.ad_name || '',
      referrals: 0,
      customers: 0,
      contacts: 0,
      last_referral: null
    };
    const accountId = String(row.ad_account_id || current.ad_account_id || '');
    const account = accounts.get(accountId);
    Object.assign(current, {
      page_id: current.page_id || row.page_id || '',
      page_name: current.page_name || row.page_name || pages.get(String(row.page_id || '')) || '',
      ad_title: row.ad_name || current.ad_title,
      campaign_id: row.campaign_id || current.campaign_id,
      campaign_name: row.campaign_name || current.campaign_name,
      adset_id: row.adset_id || current.adset_id,
      adset_name: row.adset_name || current.adset_name,
      ad_account_id: accountId,
      ad_account_name: row.ad_account_name || account?.ad_account_name || current.ad_account_name,
      business_id: row.business_id || account?.business_id || current.business_id || '',
      business_name: row.business_name || account?.business_name || current.business_name || '',
      effective_status: row.effective_status || row.status || current.effective_status
    });
    const mapping = state.mappings.find(item => String(item.ad_id) === id);
    current.mapping = mapping || current.mapping;
    current.mapped = mappingHasUsableScope(mapping);
    ads.set(id, current);
  }
  for (const current of ads.values()) {
    const account = accounts.get(String(current.ad_account_id || current.mapping?.ad_account_id || ''));
    current.ad_account_id ||= account?.ad_account_id || current.mapping?.ad_account_id || '';
    current.ad_account_name ||= account?.ad_account_name || current.mapping?.ad_account_name || '';
    current.business_id ||= account?.business_id || '';
    current.business_name ||= account?.business_name || '';
  }
  state.currentAds = [...ads.values()];
}

async function loadMeta(sync = false) {
  try {
    const response = await fetch(`/api/ad-mapping/meta?sync=${sync ? '1' : '0'}`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `Meta HTTP ${response.status}`);
    state.metaAds = Array.isArray(data.rows) ? data.rows : [];
    mergeAccounts(data.ad_accounts || []);
    mergeBusinesses(data.businesses || []);
    state.metaError = '';
    mergeMetaAds();
    return data;
  } catch (error) {
    state.metaError = error.message || String(error);
    if (sync) throw error;
    console.warn('Meta list unavailable', error);
    return null;
  }
}

async function loadAll(showMessage = true) {
  busy(true);
  try {
    const data = await api('/api/v8-mapping-center/bootstrap?days=45');
    state.data = data;
    state.currentAds = data.current_ads || [];
    state.mappings = data.mappings || [];
    state.catalogs = data.catalogs || [];
    state.groups = data.groups || [];
    state.folders = data.asset_summary?.folders || [];
    if (state.driveTree.length) mergeDriveTreeFolders(state.driveTree);
    state.slideMappings = data.slide_mappings || [];
    state.adAccounts = [];
    state.businesses = [];
    mergeAccounts(data.ad_accounts || []);
    mergeBusinesses(data.businesses || []);
    await loadMeta(false);
    fillSelects();
    renderAll();
    if (showMessage) status(state.metaError ? `Đã nạp Mapping; Meta chưa đồng bộ: ${state.metaError}` : 'Đã nạp dữ liệu Mapping mới nhất.', Boolean(state.metaError));
  } catch (error) {
    status(error.message, true);
  } finally {
    busy(false);
  }
}

async function syncMeta() {
  busy(true);
  try {
    await loadMeta(true);
    await loadAll(false);
    status('Đã đồng bộ danh sách QC, tài khoản quảng cáo và BM từ Meta.');
  } catch (error) {
    status(error.message, true);
  } finally {
    busy(false);
  }
}

function fillSelect(element, rows, valueKey, labelFn, firstLabel) {
  const oldValue = element.value;
  element.innerHTML = firstLabel ? `<option value="">${esc(firstLabel)}</option>` : '';
  for (const row of rows) {
    const option = document.createElement('option');
    option.value = row[valueKey] || '';
    option.textContent = labelFn(row);
    element.appendChild(option);
  }
  if ([...element.options].some(option => option.value === oldValue)) element.value = oldValue;
}

function catalogTreeRows(rows = state.catalogs) {
  const byKey = new Map(rows.map(row => [String(row.catalog_key || ''), row]));
  const children = new Map();
  for (const row of rows) {
    const parent = String(row.parent_key || '');
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(row);
  }
  const sortRows = list => list.sort((a, b) => String(a.catalog_name || a.catalog_key).localeCompare(String(b.catalog_name || b.catalog_key), 'vi'));
  const roots = sortRows(rows.filter(row => !row.parent_key || !byKey.has(String(row.parent_key))));
  const result = [];
  const visited = new Set();
  const walk = (row, depth) => {
    const key = String(row.catalog_key || '');
    if (!key || visited.has(key)) return;
    visited.add(key);
    result.push({ ...row, _depth: depth });
    for (const child of sortRows([...(children.get(key) || [])])) walk(child, depth + 1);
  };
  roots.forEach(row => walk(row, 0));
  sortRows(rows.filter(row => !visited.has(String(row.catalog_key || '')))).forEach(row => walk(row, 0));
  return result;
}

function folderTreeRows() {
  const rows = [...state.folders].map(folder => {
    const path = String(folder.folder_path || folder.folder_name || folder.folder_id || '').replace(/^\/+|\/+$/g, '').replace(/\s*\/\s*/g, '/');
    return { ...folder, folder_id: String(folder.folder_id || ''), parent_folder_id: String(folder.parent_folder_id || folder.parent_id || ''), _path: path };
  }).filter(folder => folder.folder_id);
  const byId = new Map(rows.map(folder => [folder.folder_id, folder]));
  const byPath = new Map();
  for (const folder of rows) {
    const key = folder._path.toLocaleLowerCase('vi-VN');
    const ids = byPath.get(key) || [];
    ids.push(folder.folder_id);
    byPath.set(key, ids);
  }
  for (const folder of rows) {
    if (folder.parent_folder_id && byId.has(folder.parent_folder_id) && folder.parent_folder_id !== folder.folder_id) continue;
    folder.parent_folder_id = '';
    const parts = folder._path.split('/').filter(Boolean);
    while (parts.length > 1 && !folder.parent_folder_id) {
      parts.pop();
      const candidates = (byPath.get(parts.join('/').toLocaleLowerCase('vi-VN')) || []).filter(id => id !== folder.folder_id);
      if (candidates.length === 1) folder.parent_folder_id = candidates[0];
    }
  }
  const children = new Map();
  for (const folder of rows) {
    const parent = folder.parent_folder_id && byId.has(folder.parent_folder_id) ? folder.parent_folder_id : '';
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(folder);
  }
  const sortFolders = list => list.sort((a, b) => String(a.folder_name || a.folder_id).localeCompare(String(b.folder_name || b.folder_id), 'vi', { numeric: true, sensitivity: 'base' }));
  const result = [];
  const visited = new Set();
  const walk = (folder, depth) => {
    if (visited.has(folder.folder_id)) return;
    visited.add(folder.folder_id);
    result.push({ ...folder, _depth: depth });
    for (const child of sortFolders([...(children.get(folder.folder_id) || [])])) walk(child, depth + 1);
  };
  for (const root of sortFolders([...(children.get('') || [])])) walk(root, 0);
  for (const folder of sortFolders(rows.filter(folder => !visited.has(folder.folder_id)))) walk(folder, 0);
  return result;
}

function mergeDriveTreeFolders(rows = []) {
  const folders = new Map(state.folders.map(folder => [String(folder.folder_id || ''), folder]));
  const liveIds = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row.id || row.folder_id || '').trim();
    if (!id) continue;
    liveIds.add(id);
    const current = folders.get(id) || { folder_id: id, catalogs: [] };
    folders.set(id, {
      ...current,
      folder_id: id,
      folder_name: row.name || row.folder_name || current.folder_name || id,
      folder_path: row.path || row.folder_path || current.folder_path || row.name || id,
      folder_url: current.folder_url || `https://drive.google.com/drive/folders/${id}`,
      parent_folder_id: row.parent_id || row.parent_folder_id || current.parent_folder_id || null,
      direct_images: Number(row.direct_images ?? current.direct_images ?? 0),
      images: Number(row.images ?? current.images ?? row.direct_images ?? 0),
      total_images: Number(row.images ?? current.total_images ?? current.images ?? row.direct_images ?? 0),
      direct_child_count: Number(row.direct_child_count ?? current.direct_child_count ?? 0),
      child_count: Number(row.child_count ?? current.child_count ?? 0),
      live_drive: true
    });
  }
  const configuredIds = new Set();
  const remember = value => {
    const id = String(typeof value === 'string' ? value : (value?.id || value?.folder_id || value?.drive_folder_id || '')).trim();
    if (id) configuredIds.add(id);
  };
  for (const catalog of state.catalogs) remember(catalog.drive_folder_id);
  for (const mapping of state.mappings) {
    for (const value of mapping.resolved_folder_ids || mapping.selected_folders || mapping.drive_folders || []) remember(value);
  }
  for (const mapping of state.slideMappings) {
    for (const value of mapping.drive_folder_ids || []) remember(value);
    remember(mapping.drive_folder_id);
  }
  state.folders = [...folders.values()]
    .filter(folder => !liveIds.size || liveIds.has(String(folder.folder_id)) || configuredIds.has(String(folder.folder_id)))
    .map(folder => liveIds.has(String(folder.folder_id)) ? folder : { ...folder, unavailable_on_drive: liveIds.size > 0 });
}

async function loadDriveTree(force = false) {
  if (state.driveTreeLoaded && !force) return state.driveTree;
  if (state.driveTreePromise && !force) return state.driveTreePromise;
  state.driveTreePromise = api('/api/slide-manager/drive/tree').then(data => {
    state.driveTree = Array.isArray(data.folders) ? data.folders : [];
    state.driveTreeLoaded = true;
    mergeDriveTreeFolders(state.driveTree);
    renderFolderPicker('m_folders');
    renderFolderPicker('sm_folders');
    if (typeof renderProducts === 'function') renderProducts();
    return state.driveTree;
  }).finally(() => { state.driveTreePromise = null; });
  return state.driveTreePromise;
}

async function refreshDriveTree() {
  busy(true);
  try {
    await loadDriveTree(true);
    status(`Đã tải cây Google Drive: ${state.driveTree.length} thư mục, xếp đúng cha — con.`);
  } catch (error) {
    status(`Không tải được cây Google Drive: ${error.message}`, true);
  } finally {
    busy(false);
  }
}

function fillAccountFilters() {
  fillSelect($('currentBusiness'), state.businesses, 'business_id', row => `BM: ${row.business_name || row.business_id}`, 'Tất cả BM AIGUKA nhìn thấy');
  fillAccountSelect();
}

function fillAccountSelect() {
  const businessId = $('currentBusiness').value;
  const accounts = state.adAccounts.filter(row => !businessId || String(row.business_id || '') === businessId);
  fillSelect($('currentAccount'), accounts, 'ad_account_id', row => `${row.ad_account_name || row.ad_account_id} — ${row.ad_account_id}`, 'Tất cả tài khoản QC');
}

function businessFilterChanged() {
  fillAccountSelect();
  renderCurrent();
}

function fillSelects() {
  const pages = state.data?.pages || [];
  fillAccountFilters();
  fillSelect($('testPage'), pages, 'page_id', row => row.page_name || row.page_id, 'Chọn Page');
  fillSelect($('sm_page'), pages, 'page_id', row => row.page_name || row.page_id, 'Tất cả Page');
  fillSelect($('m_group'), state.groups, 'group_key', row => `${row.group_name} — ${row.group_key}`, 'Chưa chọn / QC tổng hợp');
  const catalogs = catalogTreeRows();
  fillSelect($('m_catalog'), catalogs, 'catalog_key', row => `${'— '.repeat(row._depth)}${row.catalog_name} — ${row.catalog_key}`, 'Chưa chọn / QC tổng hợp');
  fillSelect($('sm_product'), catalogs, 'catalog_key', row => `${'— '.repeat(row._depth)}${row.catalog_name} — ${row.catalog_key}`, 'Chọn catalog');
  renderFolderPicker('m_folders');
  renderFolderPicker('sm_folders');
}

function folderSelection(id) {
  if (!state.folderSelections[id]) state.folderSelections[id] = new Set();
  return state.folderSelections[id];
}

function setFolderSelection(id, values = []) {
  const ids = values.map(value => String(typeof value === 'string' ? value : (value?.id || value?.folder_id || value?.drive_folder_id || ''))).filter(Boolean);
  state.folderSelections[id] = new Set(ids);
  const search = $(`${id}_search`);
  if (search) search.value = '';
  renderFolderPicker(id);
}

function selectedFolderIds(id) { return [...folderSelection(id)]; }

function selectedFolderValues(id) {
  return selectedFolderIds(id).map(folderId => {
    const folder = state.folders.find(row => String(row.folder_id) === String(folderId));
    return {
      id: String(folderId),
      name: folder?.folder_name || String(folderId),
      path: folder?.folder_path || folder?.folder_name || String(folderId),
      parent_id: folder?.parent_folder_id || null
    };
  });
}

function renderFolderPicker(id) {
  const container = $(id);
  if (!container) return;
  const selection = folderSelection(id);
  const query = String($(`${id}_search`)?.value || '').trim().toLocaleLowerCase('vi-VN');
  const allRows = folderTreeRows();
  const byId = new Map(allRows.map(folder => [String(folder.folder_id), folder]));
  const visibleIds = new Set();
  if (query) {
    for (const folder of allRows) {
      if (![folder.folder_name, folder._path, ...(folder.catalogs || [])].join(' ').toLocaleLowerCase('vi-VN').includes(query)) continue;
      let current = folder;
      while (current && !visibleIds.has(String(current.folder_id))) {
        visibleIds.add(String(current.folder_id));
        current = byId.get(String(current.parent_folder_id || ''));
      }
    }
  }
  const rows = query ? allRows.filter(folder => visibleIds.has(String(folder.folder_id))) : allRows;
  container.innerHTML = rows.length ? rows.map(folder => {
    const selected = selection.has(String(folder.folder_id));
    const padding = 10 + folder._depth * 22;
    const totalImages = Number(folder.images ?? folder.total_images ?? folder.direct_images ?? 0);
    const directImages = Number(folder.direct_images ?? totalImages);
    const childCount = Number(folder.child_count || 0);
    const detail = childCount
      ? `${directImages} ảnh trực tiếp · ${childCount} thư mục con`
      : `${directImages} ảnh trực tiếp`;
    const branch = folder._depth ? '<span class="folder-branch">└─</span>' : '';
    const driveBadge = folder.live_drive
      ? '<span class="badge ok" style="margin-left:5px">Drive</span>'
      : (folder.unavailable_on_drive ? '<span class="badge warn" style="margin-left:5px">Không còn thấy trên Drive</span>' : '');
    return `<label class="folder-option${selected ? ' selected' : ''}" style="padding-left:${padding}px!important"><input type="checkbox" value="${esc(folder.folder_id)}" ${selected ? 'checked' : ''} onchange="folderSelectionChanged('${id}',this)"><span class="folder-option-content">${branch}<span class="folder-option-name">📁 ${esc(folder.folder_name || folder.folder_id)}</span><span class="badge info" style="margin-left:6px">${totalImages} ảnh tổng</span>${driveBadge}<div class="small muted folder-option-detail">${esc(detail)}</div><div class="small muted folder-option-path">${esc(folder._path)}</div></span></label>`;
  }).join('') : '<div class="empty">Không có thư mục phù hợp.</div>';
  const count = $(`${id}_count`);
  if (count) count.textContent = `${selection.size} thư mục`;
}

function folderSelectionChanged(id, checkbox) {
  const selection = folderSelection(id);
  if (checkbox.checked) selection.add(checkbox.value); else selection.delete(checkbox.value);
  renderFolderPicker(id);
}

function selectVisibleFolders(id) {
  const selection = folderSelection(id);
  $(id).querySelectorAll('input[type="checkbox"]').forEach(checkbox => selection.add(checkbox.value));
  renderFolderPicker(id);
}

function clearFolderSelection(id) {
  state.folderSelections[id] = new Set();
  renderFolderPicker(id);
}

function folderName(id) {
  const folder = state.folders.find(row => String(row.folder_id) === String(id));
  return folder?.folder_name || id;
}

function prepareDriveFrame(frame) {
  try {
    const doc = frame.contentDocument;
    if (!doc) return;
    const style = doc.createElement('style');
    style.textContent = '.wrap>.top,.wrap>.tabs{display:none!important}.wrap{max-width:none!important;padding:12px!important}#mapping,#drive,#test{display:none!important}#google{display:block!important}';
    doc.head.appendChild(style);
    doc.getElementById('google')?.classList.remove('hide');
  } catch (error) {
    console.warn('Không thể thu gọn giao diện Drive cũ', error);
  }
}

function renderAll() {
  const summary = state.data?.summary || {};
  $('sCurrent').textContent = state.currentAds.length;
  $('sMapped').textContent = state.currentAds.filter(row => row.mapped).length;
  $('sUnmapped').textContent = state.currentAds.filter(row => !row.mapped).length;
  $('sTotal').textContent = state.mappings.length;
  $('sImages').textContent = summary.active_images || 0;
  renderCurrent();
  renderMappings();
  renderProducts();
  renderRuntime();
  renderLog();
}

const initialTab = new URLSearchParams(location.search).get('tab');
if (initialTab && $('p-' + initialTab)) showTab(initialTab);
loadAll(false);
