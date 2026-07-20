import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { installMappingCenter } from '../src/routes/mappingCenterRoutes.js';

const fixtureByResource = {
  v8_pages: [{ page_id: 'page-1', page_name: 'Page 1', is_active: true }],
  v8_mapping_runtime: [],
  v8_business_product_groups: [{ group_key: 'bon_tam', group_name: 'Bồn tắm', priority: 1, is_active: true }],
  v8_product_catalog: [{
    catalog_key: 'bon_tam', catalog_name: 'Bồn tắm', parent_key: null, root_product_key: 'bon_tam',
    drive_folder_id: 'folder-bon-tam', drive_folder_url: '', folder_path: 'PHÒNG TẮM/BỒN TẮM',
    level_no: 1, is_sendable: true, is_active: true
  }],
  ad_mappings: [{
    id: 1, ad_id: 'ad-1', ad_name: 'QC tổng hợp', ad_account_id: 'account-1', ad_account_name: 'QC 1',
    campaign_id: 'campaign-1', campaign_name: 'Cửa hàng 2', adset_id: 'adset-1', adset_name: 'Cửa hàng 26-35 - Bản sao',
    product_group: '', product_item_key: '', mapping_target_type: 'scope', mapping_mode: 'legacy',
    selected_folders: ['Bathroom/Bồn tắm'], drive_folders: ['Bathroom/Bồn tắm'], enabled: true, is_active: true
  }, {
    id: 2, ad_id: 'ad-2', ad_name: 'QC tổng hợp', ad_account_id: 'account-1', ad_account_name: 'QC 1',
    campaign_id: 'campaign-2', campaign_name: 'Cửa hàng 1', adset_id: 'adset-2', adset_name: 'Cửa hàng 26km',
    product_group: '', product_item_key: '', mapping_target_type: 'scope', mapping_mode: 'legacy',
    selected_folders: [], drive_folders: [], enabled: true, is_active: true
  }],
  v8_slide_mapping: [],
  v8_meta_ad_referral_entries: [{
    page_id: 'page-1', page_name: 'Page 1', sender_id: 'customer-1', ad_id: 'ad-1', ad_title: 'QC tổng hợp',
    post_id: '', referral_source: 'ADS', referral_at: '2026-07-20T00:00:00Z', has_phone: false, has_zalo: false
  }, {
    page_id: 'page-1', page_name: 'Page 1', sender_id: 'customer-2', ad_id: 'ad-2', ad_title: 'QC tổng hợp',
    post_id: '', referral_source: 'ADS', referral_at: '2026-07-19T00:00:00Z', has_phone: false, has_zalo: false
  }],
  v8_drive_assets: [{
    product_key: 'bon_tam', catalog_key: 'bon_tam', parent_folder_id: 'folder-bon-tam',
    parent_folder_name: 'Bồn tắm', parent_folder_url: '', is_image: true, is_active: true, delivery_status: 'verified',
    metadata: { folder_path: 'PHÒNG TẮM/BỒN TẮM' }
  }, {
    product_key: 'bon_tam', catalog_key: 'bon_tam', parent_folder_id: 'folder-bon-tam-doc-lap',
    parent_folder_name: 'Bồn tắm độc lập', parent_folder_url: '', is_image: true, is_active: true, delivery_status: 'verified',
    metadata: { folder_path: 'PHÒNG TẮM/BỒN TẮM/Bồn tắm độc lập', folder_parent_id: 'folder-bon-tam' }
  }],
  v8_admin_change_log: [],
  v8_meta_ad_account_registry: [{
    ad_account_id: 'account-1', ad_account_name: 'QC 1', business_id: 'business-1', account_status: 'ACTIVE', is_active: true, source: 'oauth'
  }],
  v8_meta_ad_accounts: []
};

test('Mapping Center đồng bộ folder cũ và trả danh sách tài khoản QC/BM', async t => {
  const nativeFetch = globalThis.fetch;
  const previousMetaToken = process.env.META_ACCESS_TOKEN;
  process.env.META_ACCESS_TOKEN = 'test-meta-token';
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.origin === 'http://supabase.test' && url.pathname.startsWith('/rest/v1/')) {
      const resource = url.pathname.slice('/rest/v1/'.length);
      return new Response(JSON.stringify(fixtureByResource[resource] || []), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (url.hostname === 'graph.facebook.com') {
      const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname.endsWith('/me/adaccounts')) {
        return json({ data: [
          { id: 'account-1', account_id: 'account-1', name: 'QC 1', account_status: 1, business: { id: 'business-1', name: 'BM 1' } },
          { id: 'account-2', account_id: 'account-2', name: 'QC đã tắt', account_status: 2, business: { id: 'business-1', name: 'BM 1' } }
        ] });
      }
      if (url.pathname.endsWith('/me/businesses')) return json({ data: [{ id: 'business-1', name: 'BM 1' }] });
      if (url.pathname.includes('/act_account-1/ads')) {
        const fields = url.searchParams.get('fields') || '';
        assert.match(fields, /campaign\{id,name,status,effective_status\}/);
        assert.match(fields, /adset\{id,name,status,effective_status,promoted_object\}/);
        return json({ data: [
          {
            id: 'ad-1', name: 'QC hoạt động', account_id: 'account-1', status: 'ACTIVE', effective_status: 'ACTIVE', configured_status: 'ACTIVE',
            campaign: { id: 'campaign-1', name: 'Cửa hàng 2', status: 'ACTIVE', effective_status: 'ACTIVE' },
            adset: { id: 'adset-1', name: 'Cửa hàng 26-35 - Bản sao', status: 'ACTIVE', effective_status: 'ACTIVE', promoted_object: { page_id: 'page-1' } }
          },
          {
            id: 'ad-2', name: 'QC có nhóm đã tắt', account_id: 'account-1', status: 'ACTIVE', effective_status: 'ACTIVE', configured_status: 'ACTIVE',
            campaign: { id: 'campaign-2', name: 'Cửa hàng 1', status: 'ACTIVE', effective_status: 'ACTIVE' },
            adset: { id: 'adset-2', name: 'Cửa hàng 26km', status: 'PAUSED', effective_status: 'PAUSED', promoted_object: { page_id: 'page-1' } }
          }
        ] });
      }
      if (url.pathname.includes('/act_account-2/ads')) {
        return json({ data: [{
          id: 'ad-3', name: 'QC thuộc tài khoản đã tắt', account_id: 'account-2', status: 'ACTIVE', effective_status: 'ACTIVE', configured_status: 'ACTIVE',
          campaign: { id: 'campaign-3', name: 'Chiến dịch cũ', status: 'ACTIVE', effective_status: 'ACTIVE' },
          adset: { id: 'adset-3', name: 'Nhóm cũ', status: 'ACTIVE', effective_status: 'ACTIVE', promoted_object: { page_id: 'page-1' } }
        }] });
      }
    }
    return nativeFetch(input, options);
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
    if (previousMetaToken === undefined) delete process.env.META_ACCESS_TOKEN;
    else process.env.META_ACCESS_TOKEN = previousMetaToken;
  });

  const app = express();
  installMappingCenter(app, { supabaseUrl: 'http://supabase.test', serviceRoleKey: 'test-key' });
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const bootstrap = await nativeFetch(`${base}/api/v8-mapping-center/bootstrap?days=45`).then(response => response.json());
  assert.equal(bootstrap.ok, true);
  assert.deepEqual(bootstrap.mappings[0].resolved_folder_ids, ['folder-bon-tam']);
  assert.equal(bootstrap.mappings[0].folder_sync_status, 'synced');
  assert.equal(bootstrap.current_ads[0].ad_account_id, 'account-1');
  assert.equal(bootstrap.current_ads.length, 2);
  assert.equal(bootstrap.current_ads.find(row => row.ad_id === 'ad-1').campaign_name, 'Cửa hàng 2');
  assert.equal(bootstrap.current_ads.find(row => row.ad_id === 'ad-1').adset_name, 'Cửa hàng 26-35 - Bản sao');
  assert.equal(bootstrap.current_ads.find(row => row.ad_id === 'ad-2').campaign_name, 'Cửa hàng 1');
  assert.equal(bootstrap.current_ads.find(row => row.ad_id === 'ad-2').mapped, false);
  assert.equal(bootstrap.mappings.find(row => row.ad_id === 'ad-2').scope_status, 'missing_scope');
  assert.equal(bootstrap.summary.mapped_current_ads, 1);
  const rootFolder = bootstrap.asset_summary.folders.find(row => row.folder_id === 'folder-bon-tam');
  const childFolder = bootstrap.asset_summary.folders.find(row => row.folder_id === 'folder-bon-tam-doc-lap');
  assert.equal(rootFolder.direct_images, 1);
  assert.equal(rootFolder.images, 2);
  assert.equal(rootFolder.child_count, 1);
  assert.equal(childFolder.parent_folder_id, 'folder-bon-tam');
  assert.equal(childFolder.images, 1);
  assert.equal(bootstrap.ad_accounts[0].ad_account_name, 'QC 1');
  assert.deepEqual(bootstrap.businesses, [{ business_id: 'business-1', business_name: 'business-1' }]);

  const meta = await nativeFetch(`${base}/api/ad-mapping/meta?sync=1`).then(response => response.json());
  assert.equal(meta.ok, true);
  assert.equal(meta.rows.find(row => row.ad_id === 'ad-1').delivery_status, 'ACTIVE');
  assert.equal(meta.rows.find(row => row.ad_id === 'ad-2').delivery_status, 'ADSET_PAUSED');
  assert.equal(meta.rows.find(row => row.ad_id === 'ad-2').adset_status, 'PAUSED');
  assert.equal(meta.rows.find(row => row.ad_id === 'ad-3').delivery_status, 'ACCOUNT_DISABLED');
  assert.equal(meta.rows.find(row => row.ad_id === 'ad-3').account_status, 2);

  const html = await nativeFetch(`${base}/drive-slides`).then(response => response.text());
  assert.match(html, /id="currentBusiness"/);
  assert.match(html, /id="currentAccount"/);
  assert.match(html, /id="mappingBusiness"/);
  assert.match(html, /id="mappingAccount"/);
  assert.match(html, /Tất cả tài khoản quảng cáo/);
  assert.match(html, /id="currentMetaState"/);
  assert.match(html, /<option value="active">Meta: Đang hoạt động<\/option>/);
  assert.match(html, /id="currentTableSummary"/);
  assert.match(html, /class="folder-picker-inline"/);
  assert.match(html, /Chiến dịch \/ Nhóm quảng cáo/);
  assert.match(html, /Tên QC \/ Quảng cáo/);
  assert.match(html, /onclick="toggleStatusSort\('current'\)"/);
  assert.match(html, /onclick="toggleStatusSort\('mapping'\)"/);
  assert.match(html, /Tất cả Mapping QC/);
  assert.doesNotMatch(html, /<th>QC<\/th>|Tài khoản QC \/ Quảng cáo/);
  assert.match(html, /Chưa chọn thư mục Drive/);
  assert.match(html, /id="syncAllProducts"/);
  assert.match(html, /Đồng bộ tất cả/);
  assert.match(html, /Tải cây Drive/);
  assert.doesNotMatch(html, /id="currentSearch"|id="m_target"|id="m_recognition"/);

  const coreSource = await nativeFetch(`${base}/admin/drive-slides-v8-core.js`).then(response => response.text());
  assert.match(coreSource, /id === 'products'/);
  assert.match(coreSource, /maybeAutoSyncAllSlideMappings/);
  assert.match(coreSource, /meta_seen: false/);
  assert.match(coreSource, /meta_seen: true/);
  assert.match(coreSource, /function isActiveMetaAd/);
  assert.match(coreSource, /meta_delivery_status/);
  assert.match(coreSource, /function fillMappingAccountSelect/);
  assert.match(coreSource, /function mappingBusinessFilterChanged/);
  assert.match(coreSource, /state\.currentAds\.filter\(isActiveMetaAd\)/);

  const renderSource = await nativeFetch(`${base}/admin/drive-slides-v8-render.js`).then(response => response.text());
  const cssSource = await nativeFetch(`${base}/admin/drive-slides-v8.css`).then(response => response.text());
  const currentRenderer = renderSource.match(/function renderCurrent\(\) \{[\s\S]*?\n\}\n\nfunction mappingCurrentInfo/)?.[0] || '';
  const mappingRenderer = renderSource.match(/function renderMappings\(\) \{[\s\S]*?\n\}\n\nfunction catalogDescendantKeys/)?.[0] || '';
  const productRenderer = renderSource.match(/function renderProducts\(\) \{[\s\S]*?\n\}\n\nfunction renderRuntime/)?.[0] || '';
  assert.match(currentRenderer, /campaign_name/);
  assert.match(currentRenderer, /adset_name/);
  assert.match(currentRenderer, /statusDotHtml/);
  assert.match(currentRenderer, /metaEffectiveStatus\(row\)/);
  assert.match(currentRenderer, /currentTableSummary/);
  assert.match(currentRenderer, /ad_title/);
  assert.match(currentRenderer, /current-ad-name/);
  assert.match(currentRenderer, /QC:/);
  assert.match(currentRenderer, /colspan="5"/);
  assert.doesNotMatch(currentRenderer, /colspan="6"/);
  assert.doesNotMatch(currentRenderer, /row\.page_name|row\.page_id|class="id"|ad_account_name|business_name/);
  assert.match(mappingRenderer, /campaign_name/);
  assert.match(mappingRenderer, /adset_name/);
  assert.match(mappingRenderer, /mapping\.ad_name/);
  assert.match(mappingRenderer, /Chiến dịch:/);
  assert.match(mappingRenderer, /Nhóm:/);
  assert.match(mappingRenderer, /hasRecentReferral/);
  assert.match(mappingRenderer, /mappingBusiness/);
  assert.match(mappingRenderer, /mappingAccount/);
  assert.match(mappingRenderer, /mappingAccountContext/);
  assert.match(mappingRenderer, /statusDotHtml/);
  assert.doesNotMatch(mappingRenderer, /class="id"|mapping\.ad_account_name/);
  assert.match(productRenderer, /statusDotHtml/);
  assert.match(productRenderer, /compactFolderHtml/);
  assert.match(renderSource, /folder-disclosure/);
  assert.match(renderSource, /folder-toggle-label/);
  assert.match(renderSource, /Mở rộng/);
  assert.match(cssSource, /status-dot/);
  assert.match(cssSource, /folder-disclosure/);
  assert.match(cssSource, /header-sort/);
  assert.match(cssSource, /current-ad-name/);
  assert.match(renderSource, /QC chưa tạo Mapping/);
  assert.match(renderSource, /QC cũ đã có bản ghi/);
  assert.match(renderSource, /Mapping đã tắt/);
  assert.match(renderSource, /Thiếu nguồn ảnh/);
  assert.match(renderSource, /ACCOUNT_DISABLED/);
  assert.match(renderSource, /ACCOUNT_UNSETTLED/);
  assert.match(renderSource, /ACCOUNT_CLOSED/);
  assert.match(renderSource, /syncAllSlideMappings/);
  assert.match(renderSource, /maybeAutoSyncAllSlideMappings/);
  assert.match(renderSource, /\/api\/slide-manager\/drive\/sync-all/);
  assert.doesNotMatch(renderSource, /syncSlideMapping|Đồng bộ ngay/);
});
