import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { installDriveSlideManagerV4 } from '../drive-slide-manager-v4.js';

const folderMime = 'application/vnd.google-apps.folder';
const image = (id, name) => ({
  id,
  name,
  mimeType: 'image/jpeg',
  webViewLink: `https://drive.google.com/file/d/${id}/view`,
  size: '1000'
});

test('Drive V4 đọc đúng cây cha-con, đếm ảnh đệ quy và đồng bộ mapping dùng folder ID dạng chuỗi', async t => {
  const nativeFetch = globalThis.fetch;
  let connection = null;
  const mappings = [];
  const assets = [];
  const driveItems = {
    root: [{ id: 'f56', name: 'Quạt trần 5-6 cánh', mimeType: folderMime }],
    f56: [1, 2, 3, 4].map(number => ({ id: `child-${number}`, name: `Nhóm ${number}`, mimeType: folderMime })),
    'child-1': [image('img-1', '1.jpg'), image('img-2', '2.jpg')],
    'child-2': [image('img-3', '3.jpg'), image('img-4', '4.jpg'), image('img-5', '5.jpg')],
    'child-3': [image('img-6', '6.jpg'), image('img-7', '7.jpg')],
    'child-4': [image('img-8', '8.jpg'), image('img-9', '9.jpg'), image('img-10', '10.jpg')]
  };
  const folderNames = {
    root: 'Tổng Kho',
    f56: 'Quạt trần 5-6 cánh',
    'child-1': 'Nhóm 1',
    'child-2': 'Nhóm 2',
    'child-3': 'Nhóm 3',
    'child-4': 'Nhóm 4'
  };

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.origin === 'http://supabase.test' && url.pathname.startsWith('/rest/v1/')) {
      const resource = url.pathname.slice('/rest/v1/'.length);
      const method = String(options.method || 'GET').toUpperCase();
      const body = options.body ? JSON.parse(String(options.body)) : null;
      let data = [];
      if (resource === 'v8_google_drive_connections') {
        if (method === 'POST') {
          connection = { ...(connection || {}), ...body };
          data = [connection];
        } else data = connection ? [connection] : [];
      } else if (resource === 'v8_slide_mapping') {
        if (method === 'POST') {
          const row = { id: `mapping-${mappings.length + 1}`, ...body };
          mappings.push(row);
          data = [row];
        } else if (method === 'PATCH') {
          const id = String(url.searchParams.get('id') || '').replace(/^eq\./, '');
          const row = mappings.find(item => item.id === id);
          if (row) Object.assign(row, body);
          data = row ? [row] : [];
        } else {
          const id = String(url.searchParams.get('id') || '').replace(/^eq\./, '');
          data = id ? mappings.filter(item => item.id === id) : mappings;
        }
      } else if (resource === 'v8_drive_assets') {
        if (method === 'POST') {
          const row = { id: `asset-${assets.length + 1}`, ...body };
          assets.push(row);
          data = [row];
        } else if (method === 'PATCH') {
          const id = String(url.searchParams.get('id') || '').replace(/^eq\./, '');
          const row = assets.find(item => item.id === id);
          if (row) Object.assign(row, body);
          data = row ? [row] : [];
        } else {
          const driveFileId = String(url.searchParams.get('drive_file_id') || '').replace(/^eq\./, '');
          data = driveFileId ? assets.filter(item => item.drive_file_id === driveFileId) : assets;
        }
      }
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.origin === 'https://www.googleapis.com' && url.pathname.startsWith('/drive/v3/files')) {
      const match = url.pathname.match(/\/drive\/v3\/files\/([^/]+)$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        return new Response(JSON.stringify({ id, name: folderNames[id] || id, mimeType: folderMime, owners: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const parentId = decodeURIComponent(String(url.searchParams.get('q') || '').match(/^'([^']+)'/)?.[1] || '');
      return new Response(JSON.stringify({ files: driveItems[parentId] || [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return nativeFetch(input, options);
  };
  t.after(() => { globalThis.fetch = nativeFetch; });

  const app = express();
  installDriveSlideManagerV4(app, { supabaseUrl: 'http://supabase.test', serviceRoleKey: 'test-service-role-key' });
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const connected = await nativeFetch(`${base}/api/slide-manager/google/api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'test-google-key', root_folder_id: 'root' })
  }).then(response => response.json());
  assert.equal(connected.ok, true);

  const tree = await nativeFetch(`${base}/api/slide-manager/drive/tree`).then(response => response.json());
  assert.equal(tree.ok, true);
  const fanFolder = tree.folders.find(folder => folder.id === 'f56');
  assert.equal(fanFolder.direct_images, 0);
  assert.equal(fanFolder.images, 10);
  assert.equal(fanFolder.direct_child_count, 4);
  assert.equal(fanFolder.child_count, 4);
  assert.deepEqual(tree.folders.filter(folder => folder.parent_id === 'f56').map(folder => folder.id), ['child-1', 'child-2', 'child-3', 'child-4']);

  const saved = await nativeFetch(`${base}/api/slide-manager/mapping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product_key: 'quat_5_6_canh', product_name: 'Quạt trần 5-6 cánh', drive_folder_ids: ['f56'] })
  }).then(response => response.json());
  assert.equal(saved.ok, true);
  assert.equal(saved.data.drive_folder_ids[0].id, 'f56');

  const synced = await nativeFetch(`${base}/api/slide-manager/drive/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapping_id: saved.data.id })
  }).then(response => response.json());
  assert.equal(synced.ok, true);
  assert.equal(synced.folders_scanned, 5);
  assert.equal(synced.synced, 10);
  assert.equal(assets.length, 10);
  assert.equal(new Set(assets.map(asset => asset.parent_folder_id)).size, 4);
  assert.ok(assets.every(asset => asset.metadata.folder_path.startsWith('Quạt trần 5-6 cánh / Nhóm')));
  assert.ok(assets.every(asset => asset.metadata.folder_parent_id === 'f56'));
});
