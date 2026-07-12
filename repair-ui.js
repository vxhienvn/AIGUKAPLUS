export function repairExtraUiHtml(html){
  return html.replace(
    /Không thể chuyển chế độ:\n'\+\(r\.blockers\|\|\[\]\)\.join\('\n'\)/g,
    "Không thể chuyển chế độ:\\n'+(r.blockers||[]).join('\\n')"
  );
}
