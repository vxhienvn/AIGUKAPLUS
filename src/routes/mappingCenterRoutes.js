const path = require('path');

module.exports = function registerMappingCenter(app) {
    const SUPABASE_URL = String(
        process.env.SUPABASE_URL ||
        process.env.SUPABASE_PROJECT_URL ||
        process.env.NEXT_PUBLIC_SUPABASE_URL ||
        ''
    ).replace(/\/$/, '');
    const SUPABASE_KEY = String(
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.SUPABASE_KEY ||
        process.env.SUPABASE_ANON_KEY ||
        ''
    );
    const MAPPING_ADMIN_KEY = String(
        process.env.MAPPING_ADMIN_KEY ||
        process.env.ADMIN_KEY ||
        process.env.ADMIN_API_KEY ||
        ''
    );

    function mappingApiReady() {
        return Boolean(SUPABASE_URL && SUPABASE_KEY);
    }

    function mappingHeaders(extra = {}) {
        return {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            ...extra
        };
    }

    async function supabaseRest(resource, options = {}) {
        if (!mappingApiReady()) {
            const error = new Error('Railway chưa có SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY.');
            error.status = 503;
            throw error;
        }
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${resource}`, {
            ...options,
            headers: mappingHeaders(options.headers || {})
        });
        const raw = await response.text();
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = raw; }
        if (!response.ok) {
            const message = data?.message || data?.error || data?.hint || raw || `Supabase HTTP ${response.status}`;
            const error = new Error(message);
            error.status = response.status;
            error.details = data;
            throw error;
        }
        return data;
    }

    async function safeSupabaseRest(resource, fallback = [], options = {}) {
        try {
            return { data: await supabaseRest(resource, options), error: null };
        } catch (error) {
            console.warn(`[MAPPING_CENTER] ${resource}:`, error.message);
            return { data: fallback, error: error.message };
        }
    }

    function requireMappingWrite(req, res, next) {
        if (!MAPPING_ADMIN_KEY) {
            // The legacy Railway admin page was already same-origin and did not have a
            // dedicated mapping login. Keep compatibility, but reject cross-origin writes.
            const origin = String(req.get('origin') || '');
            const host = String(req.get('host') || '');
            if (origin && host && !origin.includes(host)) {
                return res.status(403).json({ ok: false, error: 'Cross-origin mapping write is blocked.' });
            }
            return next();
        }
        const provided = String(req.get('x-admin-key') || req.query.admin_key || '');
        if (provided !== MAPPING_ADMIN_KEY) {
            return res.status(401).json({ ok: false, error: 'Sai khóa quản trị Mapping.', requires_admin_key: true });
        }
        return next();
    }

    function detachExactRoute(routePath) {
        const router = app._router;
        if (!router || !Array.isArray(router.stack)) return [];
        const removed = [];
        router.stack = router.stack.filter(layer => {
            if (layer?.route?.path === routePath) {
                removed.push(layer);
                return false;
            }
            return true;
        });
        return removed;
    }

    // Preserve the working Google Drive/OAuth page under a legacy URL, then replace
    // /drive-slides with the unified Mapping Center.
    const legacyDriveSlideLayers = detachExactRoute('/drive-slides');
    if (legacyDriveSlideLayers.length) {
        const handlers = legacyDriveSlideLayers.flatMap(layer =>
            Array.isArray(layer?.route?.stack) ? layer.route.stack.map(item => item.handle).filter(Boolean) : []
        );
        if (handlers.length) app.get('/drive-slides-legacy', ...handlers);
    }

    app.get('/drive-slides', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'drive-slides-v8.html'));
    });

    function aggregateCurrentAds(referrals = [], mappings = []) {
        const mappingByAd = new Map((Array.isArray(mappings) ? mappings : []).map(row => [String(row.ad_id || ''), row]));
        const byKey = new Map();
        for (const row of Array.isArray(referrals) ? referrals : []) {
            const adId = String(row.ad_id || '').trim();
            if (!adId) continue;
            const pageId = String(row.page_id || '').trim();
            const key = `${pageId}:${adId}`;
            const current = byKey.get(key) || {
                page_id: pageId,
                page_name: row.page_name || '',
                ad_id: adId,
                ad_title: row.ad_title || '',
                post_id: row.post_id || '',
                referral_source: row.referral_source || '',
                referrals: 0,
                customers: new Set(),
                contacts: new Set(),
                first_referral: row.referral_at || null,
                last_referral: row.referral_at || null
            };
            current.referrals += 1;
            if (row.sender_id) current.customers.add(String(row.sender_id));
            if ((row.has_phone || row.has_zalo) && row.sender_id) current.contacts.add(String(row.sender_id));
            if (row.ad_title && !current.ad_title) current.ad_title = row.ad_title;
            if (row.page_name && !current.page_name) current.page_name = row.page_name;
            if (row.post_id && !current.post_id) current.post_id = row.post_id;
            const time = row.referral_at ? new Date(row.referral_at).getTime() : 0;
            if (!current.last_referral || time > new Date(current.last_referral).getTime()) current.last_referral = row.referral_at;
            if (!current.first_referral || time < new Date(current.first_referral).getTime()) current.first_referral = row.referral_at;
            byKey.set(key, current);
        }
        return [...byKey.values()].map(row => {
            const mapping = mappingByAd.get(row.ad_id) || null;
            return {
                ...row,
                customers: row.customers.size,
                contacts: row.contacts.size,
                mapped: Boolean(mapping && mapping.is_active !== false && mapping.enabled !== false),
                mapping
            };
        }).sort((a, b) => new Date(b.last_referral || 0) - new Date(a.last_referral || 0));
    }

    function aggregateAssets(assets = []) {
        const byCatalog = new Map();
        const folders = new Map();
        for (const row of Array.isArray(assets) ? assets : []) {
            const catalogKey = String(row.catalog_key || row.product_key || '').trim();
            if (catalogKey) {
                const current = byCatalog.get(catalogKey) || { catalog_key: catalogKey, product_key: row.product_key || '', images: 0, verified: 0, errors: 0, folders: new Set() };
                current.images += 1;
                if (row.delivery_status === 'verified') current.verified += 1;
                if (row.delivery_status === 'error') current.errors += 1;
                if (row.parent_folder_id) current.folders.add(String(row.parent_folder_id));
                byCatalog.set(catalogKey, current);
            }
            const folderId = String(row.parent_folder_id || '').trim();
            if (folderId) {
                const folder = folders.get(folderId) || {
                    folder_id: folderId,
                    folder_name: row.parent_folder_name || folderId,
                    folder_url: row.parent_folder_url || '',
                    images: 0,
                    catalogs: new Set()
                };
                folder.images += 1;
                if (catalogKey) folder.catalogs.add(catalogKey);
                folders.set(folderId, folder);
            }
        }
        return {
            by_catalog: [...byCatalog.values()].map(row => ({ ...row, folders: [...row.folders] })),
            folders: [...folders.values()].map(row => ({ ...row, catalogs: [...row.catalogs] })).sort((a, b) => a.folder_name.localeCompare(b.folder_name, 'vi'))
        };
    }

    app.get('/api/v8-mapping-center/bootstrap', async (req, res) => {
        try {
            const days = Math.min(Math.max(Number(req.query.days || 45), 7), 180);
            const since = new Date(Date.now() - days * 86400000).toISOString();
            const queries = await Promise.all([
                safeSupabaseRest('v8_pages?select=page_id,page_name,is_active,runtime_mode&order=page_name.asc'),
                safeSupabaseRest('v8_mapping_runtime?select=*&order=page_id.asc'),
                safeSupabaseRest('v8_business_product_groups?select=group_key,group_name,priority,is_active&is_active=eq.true&order=priority.asc'),
                safeSupabaseRest('v8_product_catalog?select=catalog_key,catalog_name,parent_key,root_product_key,drive_folder_id,drive_folder_url,folder_path,level_no,is_sendable,is_active&is_active=eq.true&order=level_no.asc,catalog_name.asc'),
                safeSupabaseRest('ad_mappings?select=*&order=updated_at.desc&limit=2000'),
                safeSupabaseRest('v8_slide_mapping?select=*&order=priority.asc,product_name.asc&limit=1000'),
                safeSupabaseRest(`v8_meta_ad_referral_entries?select=page_id,page_name,sender_id,ad_id,ad_title,post_id,referral_source,referral_at,has_phone,has_zalo&is_ad_referral=eq.true&referral_at=gte.${encodeURIComponent(since)}&order=referral_at.desc&limit=10000`),
                safeSupabaseRest('v8_drive_assets?select=product_key,catalog_key,parent_folder_id,parent_folder_name,parent_folder_url,is_image,is_active,delivery_status&is_active=eq.true&is_image=eq.true&limit=10000'),
                safeSupabaseRest("v8_admin_change_log?select=*&or=(asset_type.ilike.*mapping*,action.ilike.*mapping*)&order=created_at.desc&limit=50")
            ]);
            const [pages, runtime, groups, catalogs, mappings, slideMappings, referrals, assets, changeLog] = queries;
            const assetSummary = aggregateAssets(assets.data);
            const currentAds = aggregateCurrentAds(referrals.data, mappings.data);
            const mappedCurrent = currentAds.filter(row => row.mapped).length;
            res.json({
                ok: true,
                version: 'railway_unified_mapping_center_v1',
                generated_at: new Date().toISOString(),
                days,
                requires_admin_key: Boolean(MAPPING_ADMIN_KEY),
                pages: pages.data,
                runtime: runtime.data,
                groups: groups.data,
                catalogs: catalogs.data,
                mappings: mappings.data,
                slide_mappings: slideMappings.data,
                current_ads: currentAds,
                asset_summary: assetSummary,
                change_log: changeLog.data,
                summary: {
                    current_ads: currentAds.length,
                    mapped_current_ads: mappedCurrent,
                    unmapped_current_ads: currentAds.length - mappedCurrent,
                    total_mappings: Array.isArray(mappings.data) ? mappings.data.length : 0,
                    active_images: Array.isArray(assets.data) ? assets.data.length : 0
                },
                warnings: queries.map(item => item.error).filter(Boolean)
            });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: error.message, details: error.details || null });
        }
    });

    app.post('/api/v8-mapping-center/ad-mapping', requireMappingWrite, async (req, res) => {
        try {
            const input = req.body || {};
            const adId = String(input.ad_id || '').trim();
            if (!adId) return res.status(400).json({ ok: false, error: 'Thiếu Ad ID.' });
            const folders = Array.isArray(input.selected_folders) ? input.selected_folders.filter(Boolean) : [];
            const row = {
                ad_account_id: String(input.ad_account_id || '').trim(),
                ad_account_name: String(input.ad_account_name || '').trim(),
                campaign_id: String(input.campaign_id || '').trim(),
                campaign_name: String(input.campaign_name || '').trim(),
                adset_id: String(input.adset_id || '').trim(),
                adset_name: String(input.adset_name || '').trim(),
                ad_id: adId,
                ad_name: String(input.ad_name || input.ad_title || '').trim(),
                product_type: String(input.product_type || '').trim(),
                product_name: String(input.product_name || '').trim(),
                product_group: String(input.product_group || '').trim(),
                product_item_key: String(input.product_item_key || '').trim(),
                recognition_name: String(input.recognition_name || input.ad_name || input.ad_title || '').trim(),
                mapping_target_type: String(input.mapping_target_type || (input.product_item_key ? 'product' : 'group')).trim(),
                mapping_mode: String(input.mapping_mode || 'manual_v8').trim(),
                carousel_key: String(input.carousel_key || '').trim(),
                slide_key: String(input.slide_key || input.product_item_key || '').trim(),
                drive_folder: String(input.drive_folder || '').trim(),
                main_folder: String(input.main_folder || '').trim(),
                product_drive_path: String(input.product_drive_path || '').trim(),
                drive_folders: folders,
                selected_folders: folders,
                image_urls: Array.isArray(input.image_urls) ? input.image_urls : [],
                price_range: String(input.price_range || '').trim(),
                zalo_url: String(input.zalo_url || '').trim(),
                notes: String(input.notes || '').trim(),
                effective_status: String(input.effective_status || 'ACTIVE').trim(),
                account_status: String(input.account_status || '').trim(),
                enabled: input.enabled !== false,
                is_active: input.is_active !== false,
                updated_at: new Date().toISOString()
            };
            const existing = await supabaseRest(`ad_mappings?select=id,ad_id&ad_id=eq.${encodeURIComponent(adId)}&limit=1`);
            let saved;
            if (Array.isArray(existing) && existing.length) {
                saved = await supabaseRest(`ad_mappings?ad_id=eq.${encodeURIComponent(adId)}`, {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: JSON.stringify(row)
                });
            } else {
                saved = await supabaseRest('ad_mappings', {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: JSON.stringify(row)
                });
            }
            res.json({ ok: true, saved: Array.isArray(saved) ? saved[0] : saved });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: error.message, details: error.details || null });
        }
    });

    app.post('/api/v8-mapping-center/ad-mapping/disable', requireMappingWrite, async (req, res) => {
        try {
            const adId = String(req.body?.ad_id || '').trim();
            if (!adId) return res.status(400).json({ ok: false, error: 'Thiếu Ad ID.' });
            const saved = await supabaseRest(`ad_mappings?ad_id=eq.${encodeURIComponent(adId)}`, {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify({ enabled: false, is_active: false, updated_at: new Date().toISOString() })
            });
            res.json({ ok: true, saved });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/v8-mapping-center/runtime', requireMappingWrite, async (req, res) => {
        try {
            const pageId = String(req.body?.page_id || '').trim();
            const mode = String(req.body?.mode || 'OBSERVE').toUpperCase();
            if (!pageId) return res.status(400).json({ ok: false, error: 'Thiếu Page ID.' });
            if (!['OFF', 'OBSERVE', 'ACTIVE'].includes(mode)) return res.status(400).json({ ok: false, error: 'Chế độ Mapping không hợp lệ.' });
            const row = {
                page_id: pageId,
                mode,
                use_ad_mapping: req.body?.use_ad_mapping !== false,
                use_recent_context: req.body?.use_recent_context !== false,
                use_slide_mapping: req.body?.use_slide_mapping !== false,
                minimum_apply_confidence: Math.min(Math.max(Number(req.body?.minimum_apply_confidence ?? 0.78), 0), 1),
                recent_context_minutes: Math.min(Math.max(Number(req.body?.recent_context_minutes ?? 60), 5), 1440),
                updated_by: 'railway_mapping_center',
                updated_at: new Date().toISOString()
            };
            const existing = await supabaseRest(`v8_mapping_runtime?select=page_id&page_id=eq.${encodeURIComponent(pageId)}&limit=1`);
            const saved = Array.isArray(existing) && existing.length
                ? await supabaseRest(`v8_mapping_runtime?page_id=eq.${encodeURIComponent(pageId)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) })
                : await supabaseRest('v8_mapping_runtime', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
            res.json({ ok: true, saved: Array.isArray(saved) ? saved[0] : saved });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/v8-mapping-center/slide-mapping', requireMappingWrite, async (req, res) => {
        try {
            const input = req.body || {};
            const productKey = String(input.product_key || '').trim();
            if (!productKey) return res.status(400).json({ ok: false, error: 'Thiếu mã catalog/sản phẩm.' });
            const folderIds = Array.isArray(input.drive_folder_ids) ? input.drive_folder_ids.filter(Boolean) : [];
            const row = {
                page_id: input.page_id ? String(input.page_id).trim() : null,
                product_key: productKey,
                product_name: String(input.product_name || productKey).trim(),
                slide_url: String(input.slide_url || '').trim(),
                slide_title: String(input.slide_title || input.product_name || productKey).trim(),
                priority: Number(input.priority || 100),
                is_active: input.is_active !== false,
                note: String(input.note || '').trim(),
                drive_folder_url: String(input.drive_folder_url || '').trim(),
                drive_folder_id: String(input.drive_folder_id || folderIds[0] || '').trim() || null,
                drive_folder_ids: folderIds,
                sync_mode: String(input.sync_mode || 'drive').trim(),
                sync_status: input.request_sync ? 'requested' : String(input.sync_status || 'idle').trim(),
                sync_requested_at: input.request_sync ? new Date().toISOString() : (input.sync_requested_at || null),
                updated_at: new Date().toISOString()
            };
            let saved;
            if (input.id) {
                saved = await supabaseRest(`v8_slide_mapping?id=eq.${encodeURIComponent(String(input.id))}`, {
                    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row)
                });
            } else {
                saved = await supabaseRest('v8_slide_mapping', {
                    method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row)
                });
            }
            res.json({ ok: true, saved: Array.isArray(saved) ? saved[0] : saved });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: error.message, details: error.details || null });
        }
    });

    function catalogDescendants(catalogs, rootKey) {
        const children = new Map();
        for (const row of catalogs) {
            const parent = String(row.parent_key || '');
            if (!children.has(parent)) children.set(parent, []);
            children.get(parent).push(String(row.catalog_key || ''));
        }
        const result = new Set();
        const queue = [rootKey];
        while (queue.length) {
            const key = queue.shift();
            if (!key || result.has(key)) continue;
            result.add(key);
            for (const child of children.get(key) || []) queue.push(child);
        }
        return result;
    }

    app.post('/api/v8-mapping-center/test', async (req, res) => {
        try {
            const body = req.body || {};
            const pageId = String(body.page_id || '').trim();
            const messageText = String(body.message_text || '').trim();
            const adId = String(body.ad_id || '').trim();
            const adTitle = String(body.ad_title || '').trim();
            if (!pageId) return res.status(400).json({ ok: false, error: 'Hãy chọn Page.' });
            const referral = {
                ...(adId ? { ad_id: adId } : {}),
                ...(adTitle ? { ads_context_data: { ad_title: adTitle } } : {})
            };
            const rpc = await supabaseRest('rpc/v8_resolve_unified_mapping', {
                method: 'POST',
                body: JSON.stringify({
                    p_page_id: pageId,
                    p_sender_id: 'mapping_center_test',
                    p_message_text: messageText,
                    p_referral: referral,
                    p_before: new Date().toISOString()
                })
            });
            const result = Array.isArray(rpc) ? rpc[0] : rpc;
            const [catalogRows, assetRows] = await Promise.all([
                supabaseRest('v8_product_catalog?select=catalog_key,parent_key&is_active=eq.true&limit=5000'),
                supabaseRest('v8_drive_assets?select=id,catalog_key,product_key,parent_folder_id,parent_folder_name,file_name,file_url,delivery_url,delivery_status,sort_order&is_active=eq.true&is_image=eq.true&limit=10000')
            ]);
            const descendants = result?.catalog_key ? catalogDescendants(catalogRows || [], String(result.catalog_key)) : new Set();
            const folderIds = new Set(Array.isArray(result?.slide_folder_ids) ? result.slide_folder_ids.map(String) : []);
            const assets = (Array.isArray(assetRows) ? assetRows : []).filter(row =>
                (row.catalog_key && descendants.has(String(row.catalog_key))) ||
                (row.parent_folder_id && folderIds.has(String(row.parent_folder_id)))
            ).sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)).slice(0, 12);
            res.json({ ok: true, result, preview_assets: assets });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: error.message, details: error.details || null });
        }
    });

    app.get('/api/v8-mapping-center/health', (req, res) => {
        res.json({
            ok: mappingApiReady(),
            version: 'railway_unified_mapping_center_v1',
            supabase_configured: mappingApiReady(),
            requires_admin_key: Boolean(MAPPING_ADMIN_KEY),
            legacy_drive_route_preserved: legacyDriveSlideLayers.length > 0
        });
    });

};
