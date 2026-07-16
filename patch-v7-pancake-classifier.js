import fs from "node:fs";

const file = "v7-pancake-service.cjs";
let source = fs.readFileSync(file, "utf8");
const oldClassifier = `function pancakeClassifyProduct(text = "") {
    const t = String(text).toLowerCase();
    if (t.includes("quạt") || t.includes("quat") || t.includes("guka") || t.includes("cánh") || t.includes("canh") || t.includes("động cơ") || t.includes("dong co")) return "Quạt";
    if (t.includes("bồn cầu") || t.includes("bon cau") || t.includes("thiết bị vệ sinh") || t.includes("thiet bi ve sinh") || t.includes("sen") || t.includes("lavabo") || t.includes("vòi") || t.includes("voi") || t.includes("chậu rửa") || t.includes("chau rua")) return "Thiết bị vệ sinh";
    if (t.includes("bếp") || t.includes("bep") || t.includes("hút mùi") || t.includes("hut mui") || t.includes("chậu rửa bát") || t.includes("chau rua bat")) return "Bếp";
    if (t.includes("bồn tắm") || t.includes("bon tam")) return "Bồn tắm";
    if (t.includes("combo") || t.includes("phòng tắm") || t.includes("phong tam") || t.includes("nhà tắm") || t.includes("nha tam")) return "Combo phòng tắm";
    return "Khác";
}`;
const newClassifier = `function pancakeClassifyProduct(text = "") {
    const t = String(text || "").normalize("NFKC").toLowerCase();
    const has = (...terms) => terms.some(term => t.includes(term));
    if (has("bồn tắm", "bon tam", "bathtub")) return "Bồn tắm";
    if (has("combo phòng tắm", "combo phong tam", "combo nhà tắm", "combo nha tam", "combo vệ sinh", "combo ve sinh")) return "Combo phòng tắm - vệ sinh";
    if (has("bồn cầu", "bon cau", "toilet", "xí bệt", "xi bet", "bệt", " tbvs", "thiết bị vệ sinh", "thiet bi ve sinh")) return "Bồn cầu / Thiết bị vệ sinh";
    if (has("lavabo", "la va bo", "chậu lavabo", "chau lavabo", "tủ lavabo", "tu lavabo", "bồn rửa mặt", "bon rua mat")) return "Lavabo / Tủ lavabo";
    if (has("sen tắm", "sen tam", "sen cây", "sen cay", "vòi sen", "voi sen")) return "Sen tắm";
    if (has("vòi lavabo", "voi lavabo", "vòi rửa mặt", "voi rua mat")) return "Vòi lavabo";
    if (has("gương", "guong", "gương led", "guong led", "tủ gương", "tu guong")) return "Gương / Tủ gương";
    if (has("phụ kiện nhà tắm", "phu kien nha tam", "phụ kiện vệ sinh", "phu kien ve sinh", "vắt khăn", "vat khan")) return "Phụ kiện nhà tắm";
    if (has("chậu rửa bát", "chau rua bat", "bồn rửa bát", "bon rua bat", "chậu bếp", "chau bep", "sink")) return "Chậu rửa bát";
    if (has("vòi rửa bát", "voi rua bat", "vòi bếp", "voi bep")) return "Vòi rửa bát";
    if (has("bếp từ", "bep tu", "hút mùi", "hut mui", "máy hút", "may hut", "bếp điện", "bep dien")) return "Bếp từ - Hút mùi";
    if (has("quạt trần", "quat tran", "quạt", "quat", "guka", "10 cánh", "10 canh", "8 cánh", "8 canh", "động cơ", "dong co", "đèn chùm", "den chum")) return "Quạt trần - Đèn trùm";
    if (has("gạch", "gach", "ngói", "ngoi", "ốp lát", "op lat")) return "Gạch / Ngói";
    if (has("phòng tắm", "phong tam", "nhà tắm", "nha tam")) return "Thiết bị phòng tắm";
    if (has("nhà bếp", "nha bep", "thiết bị bếp", "thiet bi bep", "bếp", "bep")) return "Thiết bị nhà bếp";
    return "Khác";
}`;
if (!source.includes(oldClassifier)) throw new Error("PANCAKE_CLASSIFIER_ANCHOR_NOT_FOUND");
source = source.replace(oldClassifier, newClassifier);
const oldProduct = "    const product = pancakeClassifyProduct(snippet);";
const newProduct = `    const productSources = [
        snippet,
        conv.ad_name,
        conv.ad?.name,
        conv.ad_title,
        conv.campaign_name,
        conv.adset_name,
        tagText
    ].filter(Boolean).join(" ");
    const product = pancakeClassifyProduct(productSources);`;
if (!source.includes(oldProduct)) throw new Error("PANCAKE_PRODUCT_SOURCE_ANCHOR_NOT_FOUND");
source = source.replace(oldProduct, newProduct);
fs.writeFileSync(file, source, "utf8");
console.log("[AIGUKA] Pancake product classifier now uses message, ad, campaign and tags");