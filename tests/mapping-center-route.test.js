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
    product_group: '', product_item_key: '', mapping_target_type: 'scope', mapping_mode: 'legacy',
    selected_folders: ['Bathroom/Bồn tắm'], drive_folders: ['Bathroom/Bồn tắm'], enabled: true, is_active: true
  }],
  v8_slide_mapping: [],
  v8_meta_ad_referral_entries: [{
    page_id: 'page-1', page_name: 'Page 1', sender_id: 'customer-1', ad_id: 'ad-1', ad_title: 'QC tổng hợp',
    post_id: '', referral_source: 'ADS', referral_at: '2026-07-20T00:00:00Z', has_phone: false, has_zalo: false
  }],
  v8_drive_assets: [{
    product_key: 'bon_tam', catalog_key: 'bon_tam', parent_folder_id: 'folder-bon-tam',
    parent_folder_name: 'Bồn tắm', parent_folder_url: '', is_image: true, is_active: true, delivery_status: 'verified'
  }],
  v8_admin_change_log: [],
  v8_meta_ad_account_registry: [{
    ad_account_id: 'account-1', ad_account_name: 'QC 1', business_id: 'business-1', account_status: 'ACTIVE', is_active: true, source: 'oauth'
  }],
  v8_meta_ad_accounts: []
};

test('Mapping Center đồng bộ folder cũ và trả danh sách tài khoản QC/BM', async t => {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.origin === 'http://supabase.test' && url.pathname.startsWith('/rest/v1/')) {
      const resource = url.pathname.slice('/rest/v1/'.length);
      return new Response(JSON.stringify(fixtureByResource[resource] || []), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return nativeFetch(input, options);
  };
  t.after(() => { globalThis.fetch = nativeFetch; });

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
  assert.equal(bootstrap.ad_accounts[0].ad_account_name, 'QC 1');
  assert.deepEqual(bootstrap.businesses, [{ business_id: 'business-1', business_name: 'business-1' }]);

  const html = await nativeFetch(`${base}/drive-slides`).then(response => response.text());
  assert.match(html, /id="currentBusiness"/);
  assert.match(html, /id="currentAccount"/);
  assert.match(html, /class="folder-picker-inline"/);
  assert.doesNotMatch(html, /id="currentSearch"|id="m_target"|id="m_recognition"/);
});
