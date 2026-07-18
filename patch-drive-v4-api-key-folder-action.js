import fs from "node:fs";

const file = "drive-slide-manager-v4.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_DRIVE_V4_API_KEY_FOLDER_ACTION";
if (source.includes(marker)) {
  console.log("[AIGUKA] Drive V4 API-key folder action already active");
} else {
  const renderNeedle = "$('drive-write-note').innerHTML=g.can_write?'Đã có quyền tạo thư mục.':'API key chỉ đọc. Bấm tạo thư mục sẽ chuyển sang đăng nhập Google.';";
  const renderReplacement = "$('drive-write-note').innerHTML=g.can_write?'Đã có quyền tạo thư mục trực tiếp.':'API key chỉ đọc. Nút bên dưới sẽ mở đúng thư mục Google Drive để bạn tạo, sau đó bấm Tải lại.';$('folder-create').textContent=g.can_write?'+ Tạo thư mục':'Mở Drive để tạo thư mục';";
  if (!source.includes(renderNeedle)) throw new Error("DRIVE_V4_FOLDER_RENDER_ANCHOR_NOT_FOUND");
  source = source.replace(renderNeedle, renderReplacement);

  const handlerNeedle = "$('folder-create').onclick=async()=>{try{const name=$('folder-new-name').value.trim();if(!name)throw Error('Nhập tên thư mục');const j=await api('/drive/folder',{method:'POST',body:JSON.stringify({name,parent_id:folderStack.at(-1)?.id})});";
  const handlerReplacement = "$('folder-create').onclick=async()=>{try{const parent=folderStack.at(-1)?.id||D.drive_connection.root_folder_id;if(!D.drive_connection?.can_write){window.open('https://drive.google.com/drive/folders/'+encodeURIComponent(parent),'_blank','noopener');status('Đã mở đúng thư mục Google Drive. Tạo thư mục ở đó rồi quay lại bấm Tải lại.');return}const name=$('folder-new-name').value.trim();if(!name)throw Error('Nhập tên thư mục');const j=await api('/drive/folder',{method:'POST',body:JSON.stringify({name,parent_id:parent})});";
  if (!source.includes(handlerNeedle)) throw new Error("DRIVE_V4_FOLDER_HANDLER_ANCHOR_NOT_FOUND");
  source = source.replace(handlerNeedle, handlerReplacement);
  source = source.replace("</body></html>`;", "<!-- AIGUKA_DRIVE_V4_API_KEY_FOLDER_ACTION --></body></html>`;");
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA] Drive V4 folder button opens current Drive folder in API-key mode");
}
