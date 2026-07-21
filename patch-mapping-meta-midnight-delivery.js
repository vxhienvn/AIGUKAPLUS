import fs from "node:fs";

const file = "src/routes/mappingCenterRoutes.js";
let source = fs.readFileSync(file, "utf8");
let changed = false;

function replaceOnce(anchor, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(anchor)) throw new Error(`MAPPING_META_MIDNIGHT_PATCH_ANCHOR_NOT_FOUND:${label}`);
  source = source.replace(anchor, replacement);
  changed = true;
}

replaceOnce(
  `                    account_status: row.account_status || current.account_status || '',
                    source: row.source || current.source || 'supabase'`,
  `                    account_status: row.account_status || current.account_status || '',
                    timezone_name: row.timezone_name || current.timezone_name || '',
                    timezone_offset_hours_utc: row.timezone_offset_hours_utc ?? current.timezone_offset_hours_utc ?? null,
                    source: row.source || current.source || 'supabase'`,
  "normalize-account-timezone",
);

replaceOnce(
  `    function metaMetricNumber(value) {
        const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
        return Number.isFinite(parsed) ? parsed : 0;
    }
`,
  `    function metaMetricNumber(value) {
        const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function metaAccountLocalHour(account = {}) {
        const timezoneName = String(account.timezone_name || '').trim();
        if (timezoneName) {
            try {
                const formatted = new Intl.DateTimeFormat('en-GB', {
                    timeZone: timezoneName,
                    hour: '2-digit',
                    hourCycle: 'h23'
                }).format(new Date());
                const hour = Number(formatted);
                if (Number.isFinite(hour)) return hour;
            } catch (_) { /* Fall back to the numeric Meta offset. */ }
        }
        const offset = Number(account.timezone_offset_hours_utc);
        if (Number.isFinite(offset)) return new Date(Date.now() + offset * 3600000).getUTCHours();
        return new Date().getUTCHours();
    }
`,
  "account-local-hour-helper",
);

replaceOnce(
  `            const fields = 'id,account_id,name,account_status,business{id,name}';`,
  `            const fields = 'id,account_id,name,account_status,timezone_name,timezone_offset_hours_utc,business{id,name}';`,
  "meta-account-timezone-fields",
);

replaceOnce(
  `            const insightFields = 'spend,impressions,reach,date_start,date_stop';
            const insightUrl = \`https://graph.facebook.com/\${META_GRAPH_VERSION}/act_\${encodeURIComponent(accountId)}/insights?fields=\${encodeURIComponent(insightFields)}&date_preset=today&level=account&limit=1&access_token=\${encodeURIComponent(token)}\`;
            try {
                const [ads, insightResult] = await Promise.all([
                    metaPages(url, 10),
                    metaPages(insightUrl, 2).then(rows => ({ rows, verified: true })).catch(error => {
                        console.warn(\`[MAPPING_CENTER] Meta account insights \${accountId}:\`, error.message);
                        return { rows: [], verified: false };
                    })
                ]);
                const insight = insightResult.rows[0] || {};
                const account = accountById.get(accountId) || {};
                const todaySpend = metaMetricNumber(insight.spend);
                const todayImpressions = metaMetricNumber(insight.impressions);
                const accountHasDeliveryToday = insightResult.verified && todaySpend > 0 && todayImpressions > 0;
                Object.assign(account, {
                    account_delivery_verified: insightResult.verified,
                    account_has_delivery_today: accountHasDeliveryToday,
                    today_spend: todaySpend,
                    today_impressions: todayImpressions,
                    today_reach: metaMetricNumber(insight.reach),
                    insights_date_start: insight.date_start || '',
                    insights_date_stop: insight.date_stop || ''
                });`,
  `            const insightFields = 'spend,impressions,reach,date_start,date_stop';
            const todayInsightUrl = \`https://graph.facebook.com/\${META_GRAPH_VERSION}/act_\${encodeURIComponent(accountId)}/insights?fields=\${encodeURIComponent(insightFields)}&date_preset=today&level=account&limit=1&access_token=\${encodeURIComponent(token)}\`;
            const yesterdayInsightUrl = \`https://graph.facebook.com/\${META_GRAPH_VERSION}/act_\${encodeURIComponent(accountId)}/insights?fields=\${encodeURIComponent(insightFields)}&date_preset=yesterday&level=account&limit=1&access_token=\${encodeURIComponent(token)}\`;
            const account = accountById.get(accountId) || {};
            const localHour = metaAccountLocalHour(account);
            const midnightGraceHours = Math.min(Math.max(Number(process.env.META_MIDNIGHT_GRACE_HOURS || 4), 0), 8);
            const shouldCheckYesterday = localHour < midnightGraceHours;
            const readInsight = async (insightUrl, label) => metaPages(insightUrl, 2)
                .then(rows => ({ rows, verified: true }))
                .catch(error => {
                    console.warn(\`[MAPPING_CENTER] Meta account \${label} insights \${accountId}:\`, error.message);
                    return { rows: [], verified: false };
                });
            try {
                const [ads, todayResult, yesterdayResult] = await Promise.all([
                    metaPages(url, 10),
                    readInsight(todayInsightUrl, 'today'),
                    shouldCheckYesterday ? readInsight(yesterdayInsightUrl, 'yesterday') : Promise.resolve({ rows: [], verified: false })
                ]);
                const todayInsight = todayResult.rows[0] || {};
                const yesterdayInsight = yesterdayResult.rows[0] || {};
                const todaySpend = metaMetricNumber(todayInsight.spend);
                const todayImpressions = metaMetricNumber(todayInsight.impressions);
                const yesterdaySpend = metaMetricNumber(yesterdayInsight.spend);
                const yesterdayImpressions = metaMetricNumber(yesterdayInsight.impressions);
                const accountHasDeliveryToday = todayResult.verified && (todaySpend > 0 || todayImpressions > 0);
                const accountHasDeliveryYesterday = shouldCheckYesterday && yesterdayResult.verified && (yesterdaySpend > 0 || yesterdayImpressions > 0);
                const accountHasRecentDelivery = accountHasDeliveryToday || accountHasDeliveryYesterday;
                const deliveryVerified = todayResult.verified || (shouldCheckYesterday && yesterdayResult.verified);
                Object.assign(account, {
                    account_delivery_verified: deliveryVerified,
                    account_has_delivery_today: accountHasDeliveryToday,
                    account_has_recent_delivery: accountHasRecentDelivery,
                    delivery_basis: accountHasDeliveryToday ? 'today' : (accountHasDeliveryYesterday ? 'previous_day_midnight_grace' : 'none'),
                    account_local_hour: localHour,
                    today_spend: todaySpend,
                    today_impressions: todayImpressions,
                    today_reach: metaMetricNumber(todayInsight.reach),
                    previous_day_spend: yesterdaySpend,
                    previous_day_impressions: yesterdayImpressions,
                    insights_date_start: todayInsight.date_start || yesterdayInsight.date_start || '',
                    insights_date_stop: todayInsight.date_stop || yesterdayInsight.date_stop || ''
                });`,
  "timezone-aware-insights",
);

replaceOnce(
  `                            ? (resolvedAccount.account_has_delivery_today ? 'ACTIVE' : 'ACCOUNT_NO_DELIVERY')`,
  `                            ? (resolvedAccount.account_has_recent_delivery ? 'ACTIVE' : 'ACCOUNT_NO_DELIVERY')`,
  "recent-delivery-status",
);

replaceOnce(
  `                        account_has_delivery_today: Boolean(resolvedAccount.account_has_delivery_today),
                        today_spend: resolvedAccount.today_spend || 0,`,
  `                        account_has_delivery_today: Boolean(resolvedAccount.account_has_delivery_today),
                        account_has_recent_delivery: Boolean(resolvedAccount.account_has_recent_delivery),
                        delivery_basis: resolvedAccount.delivery_basis || 'none',
                        account_local_hour: resolvedAccount.account_local_hour ?? null,
                        timezone_name: resolvedAccount.timezone_name || '',
                        today_spend: resolvedAccount.today_spend || 0,
                        previous_day_spend: resolvedAccount.previous_day_spend || 0,`,
  "delivery-debug-fields",
);

if (changed) fs.writeFileSync(file, source);
console.log(`[AIGUKA] Mapping Meta midnight delivery patch ${changed ? "applied" : "already present"}`);
