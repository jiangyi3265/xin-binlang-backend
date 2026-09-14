import { CashRewards } from './cash-rewards.js';
import { randomInt } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { transaction, queryOne, queryAll, parseJson, execute } from './database.js';
import { hashPassword, verifyPassword, signToken, randomCode, randomId, safeUser } from './security.js';
import { apiError, assert, boolInt, integer, numberValue, parsePage, paged, requiredText, text, utcDayStart } from './http-utils.js';
import { accountView, customerView, poolView, prizeView, redemptionJoin, redemptionView, settingView, storeView } from './presenters.js';
const DAY = 86_400_000;
const WRITE_ADMIN_ROLES = new Set(['super_admin', 'operator']);
const STORE_ADMIN_ROLES = new Set(['super_admin', 'operator', 'sales']);
const PRIZE_STATUSES = new Set(['active', 'disabled']);
const BATCH_STATUSES = new Set(['active', 'paused', 'expired']);
const STORE_STATUSES = new Set(['active', 'disabled']);
function nowIsoDate() {
  return new Date().toISOString().slice(0, 10);
}
function uniqueConstraint(error, message) {
  if (error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062 || String(error?.message || '').includes('UNIQUE constraint failed')) {
    throw apiError(409, 'ERR_DUPLICATE', message);
  }
  throw error;
}
function accountPassword(value) {
  const password = String(value || '');
  assert(password.length >= 8 && password.length <= 128, 400, 'ERR_PASSWORD', '初始密码必须为 8 至 128 位');
  return password;
}
function chooseWeightedPrize(rows) {
  if (!rows.length) return null;
  const total = rows.reduce((sum, row) => sum + Number(row.weight || 1), 0);
  let target = randomInt(0, 1_000_000) / 1_000_000 * total;
  for (const row of rows) {
    target -= Number(row.weight || 1);
    if (target <= 0) return row;
  }
  return rows.at(-1);
}
export class PlatformService {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.wechatToken = null;
    this.cash = new CashRewards(this);
  }
  async settingsRow() {
    const row = await queryOne(this.db, 'SELECT * FROM settings WHERE id = 1');
    assert(row, 503, 'ERR_SETTINGS_MISSING', '平台活动配置未初始化，请先在总部管理后台保存一次活动设置');
    return row;
  }
  async publicConfig() {
    return settingView(await this.settingsRow());
  }
  async publicStores() {
    return (await queryAll(this.db, "SELECT * FROM stores WHERE status='active' ORDER BY created_at")).map(storeView);
  }
  async publicPools() {
    return (await queryAll(this.db, "SELECT * FROM prize_pools WHERE status='active' ORDER BY id")).map(poolView);
  }
  // 未登录也要能看到本期奖品，所以走 prizeView 的公开视图：
  // 只给名称/档位/价值/图片，库存、权重、中奖概率一律不出小程序。
  async publicPrizes() {
    const rows = await queryAll(this.db, "SELECT p.*, rr.exchange_cents, pp.name AS pool_name FROM prizes p JOIN prize_pools pp ON pp.id=p.pool_id LEFT JOIN prize_reward_rules rr ON rr.prize_id=p.id WHERE p.status='active' ORDER BY p.value_cents DESC");
    return rows.map(row => prizeView(row, true));
  }
  async audit({
    actorType,
    actorId = '',
    actorName = '',
    action,
    entityType,
    entityId = '',
    storeId = null,
    ip = '',
    position = '',
    result = '成功',
    detail = {}
  }) {
    await execute(this.db, 'INSERT INTO audit_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', randomId('LG'), actorType, actorId, actorName, action, entityType, entityId, storeId, ip, position, result, JSON.stringify(detail), Date.now());
  }
  async notice(customerId, type, title, description, linkCode = '', enqueue = true) {
    const now = Date.now();
    const id = randomId('N');
    await execute(this.db, 'INSERT INTO notices VALUES (?, ?, ?, ?, ?, ?, 0, ?)', id, customerId, type, title, description, linkCode, now);
    if (enqueue) {
      await execute(this.db, 'INSERT INTO notification_outbox VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, NULL)', randomId('OUT'), customerId, type, JSON.stringify({
        title,
        description,
        linkCode
      }), 'pending', now, '', now);
    }
    return id;
  }
  async expireOrders() {
    const now = Date.now();
    return await transaction(this.db, async () => {
      const rows = await queryAll(this.db, "SELECT id, customer_id, code, prize_snapshot_json FROM redemptions WHERE status = 'pending' AND expires_at <= ? AND NOT EXISTS (SELECT 1 FROM cash_rewards cr WHERE cr.redemption_id=redemptions.id) FOR UPDATE", now);
      const update = (...params) => execute(this.db, "UPDATE redemptions SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'", ...params);
      const updateCode = (...params) => execute(this.db, "UPDATE redeem_codes SET status = 'expired' WHERE redemption_id = ?", ...params);
      for (const row of rows) {
        await update(now, row.id);
        await updateCode(row.id);
        const prize = parseJson(row.prize_snapshot_json, {});
        await this.notice(row.customer_id, 'expired', '奖品已过期失效', `您的「${prize.name || '中奖奖品'}」因超过有效期未核销，已自动失效。`, row.code);
      }
      return rows.length;
    });
  }
  async enqueueExpiringReminders() {
    const now = Date.now();
    const deadline = now + 3 * DAY;
    const rows = await queryAll(this.db, `SELECT r.id,r.customer_id,r.code,r.expires_at,r.prize_snapshot_json
      FROM redemptions r
      WHERE r.status='pending' AND r.expires_at>? AND r.expires_at<=?
      AND NOT EXISTS (SELECT 1 FROM notices n WHERE n.customer_id=r.customer_id AND n.type='expiring' AND n.link_code=r.code)`, now, deadline);
    for (const row of rows) {
      const prize = parseJson(row.prize_snapshot_json, {});
      const days = Math.max(1, Math.ceil((row.expires_at - now) / DAY));
      await this.notice(row.customer_id, 'expiring', '中奖奖品即将到期', `您的「${prize.name || '中奖奖品'}」还剩 ${days} 天到期，请尽快到店核销。`, row.code);
    }
    return rows.length;
  }
  async wechatAccessToken() {
    const now = Date.now();
    if (this.wechatToken && this.wechatToken.expiresAt > now + 60_000) return this.wechatToken.value;
    assert(this.config.wechat.appId && this.config.wechat.appSecret, 503, 'ERR_WECHAT_NOT_CONFIGURED', '微信消息凭据尚未配置');
    const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
    url.searchParams.set('grant_type', 'client_credential');
    url.searchParams.set('appid', this.config.wechat.appId);
    url.searchParams.set('secret', this.config.wechat.appSecret);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000)
    });
    const payload = await response.json();
    assert(response.ok && payload.access_token, 502, 'ERR_WECHAT_TOKEN', payload.errmsg || '微信访问令牌获取失败');
    this.wechatToken = {
      value: payload.access_token,
      expiresAt: now + (Number(payload.expires_in || 7200) - 120) * 1000
    };
    return this.wechatToken.value;
  }
  async processNotificationOutbox(limit = 20) {
    const now = Date.now();
    const rows = await queryAll(this.db, `SELECT o.*,c.openid FROM notification_outbox o JOIN customers c ON c.id=o.customer_id
      WHERE (o.status='pending' OR (o.status='skipped' AND o.last_error='微信订阅消息未配置')) AND o.next_attempt_at<=?
      ORDER BY o.created_at LIMIT ?`, now, Math.max(1, Math.min(100, Number(limit) || 20)));
    const result = {
      selected: rows.length,
      sent: 0,
      failed: 0,
      skipped: 0
    };
    for (const row of rows) {
      const templateId = this.config.wechat.templates[row.type] || '';
      if (!this.config.wechat.appId || !this.config.wechat.appSecret || !templateId) {
        await execute(this.db, "UPDATE notification_outbox SET status='skipped',last_error='微信订阅消息未配置' WHERE id=?", row.id);
        result.skipped += 1;
        continue;
      }
      try {
        const token = await this.wechatAccessToken();
        const payload = parseJson(row.payload_json, {});
        const response = await fetch(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            touser: row.openid,
            template_id: templateId,
            page: payload.linkCode ? `pages/record/detail?code=${encodeURIComponent(payload.linkCode)}` : 'pages/index/index',
            data: {
              thing1: {
                value: String(payload.title || '倌榔服务通知').slice(0, 20)
              },
              thing2: {
                value: String(payload.description || '请进入小程序查看详情').slice(0, 20)
              },
              character_string3: {
                value: String(payload.linkCode || '--').slice(0, 32)
              }
            }
          })
        });
        const body = await response.json();
        assert(response.ok && body.errcode === 0, 502, 'ERR_WECHAT_SEND', body.errmsg || '微信消息发送失败');
        await execute(this.db, "UPDATE notification_outbox SET status='sent',attempts=attempts+1,last_error='',sent_at=? WHERE id=?", Date.now(), row.id);
        result.sent += 1;
      } catch (error) {
        const attempts = Number(row.attempts || 0) + 1;
        const final = attempts >= 5;
        const nextAt = Date.now() + Math.min(6 * 60 * 60 * 1000, 2 ** attempts * 60_000);
        await execute(this.db, 'UPDATE notification_outbox SET status=?,attempts=?,next_attempt_at=?,last_error=? WHERE id=?', final ? 'failed' : 'pending', attempts, nextAt, String(error.message || '发送失败').slice(0, 500), row.id);
        result.failed += 1;
      }
    }
    return result;
  }
  async customerWechatLogin(jsCode) {
    assert(this.config.wechat.appId && this.config.wechat.appSecret, 503, 'ERR_WECHAT_NOT_CONFIGURED', '微信登录尚未配置 AppID 与 AppSecret');
    const code = requiredText(jsCode, '微信登录凭证', 200);
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.searchParams.set('appid', this.config.wechat.appId);
    url.searchParams.set('secret', this.config.wechat.appSecret);
    url.searchParams.set('js_code', code);
    url.searchParams.set('grant_type', 'authorization_code');
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000)
    });
    const payload = await response.json();
    if (!response.ok || !payload.openid) {
      // 微信只回 errcode/errmsg，不带上下文。把可诊断的原因翻译出来，
      // 否则前端只能显示一句「微信登录未完成」，排查时无从下手。
      const reasons = {
        40013: 'AppID 无效，请核对服务端 WECHAT_APP_ID 与小程序 AppID 是否一致',
        40029: '微信登录凭证无效：通常是服务端 WECHAT_APP_ID 与小程序 AppID 不是同一个小程序，或该 code 已被使用/已过期',
        40125: 'AppSecret 无效，请在微信公众平台重置后更新服务端 WECHAT_APP_SECRET',
        40163: '微信登录凭证已被使用，请重新发起登录',
        45011: '微信登录调用过于频繁，请稍后再试'
      };
      const code = Number(payload.errcode || 0);
      throw apiError(401, 'ERR_WECHAT_LOGIN', reasons[code] || payload.errmsg || '微信登录失败', {
        errcode: code || null,
        errmsg: payload.errmsg || ''
      });
    }
    let customer = await queryOne(this.db, 'SELECT * FROM customers WHERE openid = ?', payload.openid);
    if (!customer) {
      const now = Date.now();
      const id = randomId('C');
      await execute(this.db, 'INSERT INTO customers VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)', id, payload.openid, '微信用户', '', '', '', now, now);
      customer = await queryOne(this.db, 'SELECT * FROM customers WHERE id = ?', id);
    }
    return this.customerSession(customer);
  }
  customerSession(customer) {
    return {
      token: signToken({
        sub: customer.id,
        type: 'customer',
        role: 'customer'
      }, this.config.tokenSecret, 30 * DAY / 1000),
      user: customerView(customer)
    };
  }
  async customerBootstrap(customerId) {
    await this.expireOrders();
    const settings = settingView(await this.settingsRow());
    const customer = customerView(await queryOne(this.db, 'SELECT * FROM customers WHERE id = ?', customerId));
    assert(customer, 401, 'ERR_AUTH', '用户不存在或登录已失效');
    const stores = (await queryAll(this.db, "SELECT * FROM stores WHERE status = 'active' ORDER BY id")).map(storeView);
    const pools = (await queryAll(this.db, "SELECT * FROM prize_pools WHERE status = 'active' ORDER BY id")).map(poolView);
    const prizes = (await queryAll(this.db, `SELECT p.*, rr.exchange_cents, pp.name AS pool_name FROM prizes p JOIN prize_pools pp ON pp.id=p.pool_id LEFT JOIN prize_reward_rules rr ON rr.prize_id=p.id WHERE p.status='active' ORDER BY p.value_cents DESC`)).map(row => prizeView(row, true));
    const counts = await queryOne(this.db, `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN won=1 THEN 1 ELSE 0 END) AS won,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='verified' THEN 1 ELSE 0 END) AS verified
      FROM redemptions WHERE customer_id = ?`, customerId);
    const todayCount = (await queryOne(this.db, 'SELECT COUNT(*) AS count FROM redemptions WHERE customer_id=? AND redeemed_at>=?', customerId, utcDayStart())).count;
    const couponCount = (await queryOne(this.db, "SELECT COUNT(*) AS count FROM coupons WHERE customer_id=? AND status='valid' AND expires_at>?", customerId, Date.now())).count;
    const unread = (await queryOne(this.db, 'SELECT COUNT(*) AS count FROM notices WHERE customer_id=? AND `read`=0', customerId)).count;
    return {
      config: settings,
      user: customer,
      stores,
      pools,
      prizes,
      counts: {
        total: Number(counts.total || 0),
        won: Number(counts.won || 0),
        pending: Number(counts.pending || 0),
        verified: Number(counts.verified || 0),
        coupons: Number(couponCount),
        unread: Number(unread),
        todayLeft: settings.dailyLimit === 0 ? null : Math.max(0, settings.dailyLimit - Number(todayCount))
      }
    };
  }
  async customerRecords(customerId, query = {}) {
    await this.expireOrders();
    const params = [customerId];
    let where = ' WHERE r.customer_id = ?';
    if (query.status && query.status !== 'all') {
      const allowed = new Set(['lose', 'pending', 'verified', 'expired', 'frozen']);
      assert(allowed.has(query.status), 400, 'ERR_STATUS', '记录状态不正确');
      where += ' AND r.status = ?';
      params.push(query.status);
    }
    if (query.won === '1' || query.won === 'true') where += ' AND r.won = 1';
    return (await queryAll(this.db, redemptionJoin + where + ' ORDER BY r.redeemed_at DESC', ...params)).map(redemptionView);
  }
  async customerRecord(customerId, id) {
    await this.expireOrders();
    const row = await queryOne(this.db, redemptionJoin + ' WHERE r.customer_id=? AND (r.id=? OR r.code=?)', customerId, id, String(id).toUpperCase());
    assert(row, 404, 'ERR_RECORD_NOT_FOUND', '兑奖记录不存在');
    return redemptionView(row);
  }
  async updatePreferredStore(customerId, id, storeId) {
    const row = await queryOne(this.db, 'SELECT * FROM redemptions WHERE customer_id=? AND id=?', customerId, id);
    assert(row, 404, 'ERR_RECORD_NOT_FOUND', '兑奖记录不存在');
    assert(parseJson(row.prize_snapshot_json, {}).category !== 'cash', 409, 'ERR_CASH_STORE', '现金红包通过微信领取，无需选择门店');
    assert(row.won === 1 && row.status === 'pending', 409, 'ERR_RECORD_STATE', '仅待核销订单可以更换意向门店');
    const store = await queryOne(this.db, "SELECT * FROM stores WHERE id=? AND status='active'", requiredText(storeId, '门店', 50));
    assert(store, 404, 'ERR_STORE_NOT_FOUND', '门店不存在或已停用');
    await execute(this.db, 'UPDATE redemptions SET preferred_store_id=?,updated_at=? WHERE id=?', store.id, Date.now(), id);
    await this.audit({
      actorType: 'customer',
      actorId: customerId,
      actorName: (await queryOne(this.db, 'SELECT nickname FROM customers WHERE id=?', customerId))?.nickname || '',
      action: 'change_preferred_store',
      entityType: 'redemption',
      entityId: id,
      storeId: store.id,
      result: '更新成功'
    });
    return redemptionView(await queryOne(this.db, redemptionJoin + ' WHERE r.id=?', id));
  }
  async redeem(customerId, inputCode, preferredStoreId, ip = '', selectedCard = null) {
    const code = String(inputCode || '').trim().toUpperCase();
    assert(/^[A-Z0-9]{6}$/.test(code), 400, 'ERR_FORMAT', '兑换码为 6 位字母或数字，请检查后重试');
    if (selectedCard !== null) integer(selectedCard, '所选卡牌', 1, 6);
    const now = Date.now();
    return await transaction(this.db, async () => {
      // Serialize each customer's daily quota and recover an existing result on retry.
      await queryOne(this.db, 'SELECT id FROM customers WHERE id=? FOR UPDATE', customerId);
      const previous = await queryOne(this.db, redemptionJoin + ' WHERE r.code=?', code);
      if (selectedCard !== null && previous?.customer_id === customerId) {
        return { ok: true, code: previous.won ? 'OK_WIN' : 'OK_LOSE', msg: previous.won ? '恭喜中奖' : '谢谢惠顾', record: redemptionView(previous) };
      }
      const setting = await this.settingsRow();
      assert(setting.active === 1, 409, 'ERR_CLOSED', '活动已暂停，请关注后续公告');
      const today = nowIsoDate();
      assert(today >= setting.activity_start && today <= setting.activity_end, 409, 'ERR_OUTSIDE_ACTIVITY', '当前不在活动有效期内');
      const customer = await queryOne(this.db, 'SELECT * FROM customers WHERE id = ?', customerId);
      assert(customer && !customer.blocked, 403, 'ERR_BLOCKED', customer?.blocked_reason || '账号异常已被限制参与，请联系客服');
      const usedToday = Number((await queryOne(this.db, 'SELECT COUNT(*) AS count FROM redemptions WHERE customer_id=? AND redeemed_at>=?', customerId, utcDayStart(now))).count);
      if (Number(setting.daily_limit) > 0) {
        assert(usedToday < setting.daily_limit, 429, 'ERR_LIMIT', `今日兑奖次数已用完（每日 ${setting.daily_limit} 次），请明天再来`);
      }
      const codeRow = await queryOne(this.db, `SELECT rc.*, b.pool_id, b.name AS batch_name, b.price_cents, b.win_rate_ppm, b.status AS batch_status, b.starts_at, b.expires_at
        FROM redeem_codes rc JOIN batches b ON b.id=rc.batch_id WHERE rc.code=? FOR UPDATE`, code);
      assert(codeRow, 404, 'ERR_INVALID', '兑换码不存在，请核对包装内卡片');
      assert(codeRow.status === 'unused', 409, 'ERR_USED', '该兑换码已被使用，同一卡密仅可兑奖一次');
      assert(codeRow.batch_status === 'active', 409, codeRow.batch_status === 'expired' ? 'ERR_BATCH_EXPIRED' : 'ERR_BATCH_PAUSED', codeRow.batch_status === 'expired' ? '该卡密所属批次已到期' : '该卡密所属批次已暂停');
      assert(codeRow.starts_at <= now && codeRow.expires_at > now, 409, 'ERR_BATCH_EXPIRED', '该卡密所属批次不在有效期内');
      const cashPrize = await queryOne(this.db, "SELECT MAX(value_cents) AS amount FROM prizes WHERE pool_id=? AND category='cash' AND status='active' AND stock>0", codeRow.pool_id);
      if (cashPrize?.amount != null) {
        assert(this.cash.ready(), 409, 'ERR_CASH_NOT_CONFIGURED', '本奖池现金领取尚未开放，请稍后再来，兑换码未消耗');
        assert(Number(cashPrize.amount) <= this.config.transfer.maxCents, 409, 'ERR_CASH_AMOUNT', '现金奖品配置需要调整，兑换码未消耗');
      }
      let store = preferredStoreId ? await queryOne(this.db, "SELECT * FROM stores WHERE id=? AND status='active'", preferredStoreId) : null;
      if (!store) store = await queryOne(this.db, "SELECT * FROM stores WHERE status='active' ORDER BY id LIMIT 1");
      let prize = null;
      let stockOut = false;
      const shouldWin = codeRow.forced_outcome === 'win' || codeRow.forced_outcome !== 'lose' && randomInt(0, 1_000_000) < codeRow.win_rate_ppm;
      if (shouldWin) {
        if (codeRow.forced_prize_id) {
          prize = await queryOne(this.db, 'SELECT * FROM prizes WHERE id=? AND pool_id=?', codeRow.forced_prize_id, codeRow.pool_id);
          if (!prize || prize.status !== 'active' || prize.stock <= 0) {
            stockOut = true;
            prize = null;
          }
        } else {
          prize = chooseWeightedPrize(await queryAll(this.db, "SELECT * FROM prizes WHERE pool_id=? AND status='active' AND stock>0 ORDER BY value_cents DESC", codeRow.pool_id));
        }
      }
      if (prize?.category === 'cash') {
        assert(this.cash.ready(), 409, 'ERR_CASH_NOT_CONFIGURED', '现金奖品尚未开放领取，请稍后再来，兑换码未消耗');
        assert(prize.value_cents > 0 && prize.value_cents <= this.config.transfer.maxCents, 409, 'ERR_CASH_AMOUNT', '现金奖品配置需要调整，兑换码未消耗');
      } else if (prize) {
        assert(store, 409, 'ERR_NO_STORE', '暂无可核销门店，兑换码未消耗');
      }
      if (prize) {
        const changed = await execute(this.db, "UPDATE prizes SET stock=stock-1, updated_at=? WHERE id=? AND status='active' AND stock>0", now, prize.id);
        if (Number(changed.changes) !== 1) {
          stockOut = true;
          prize = null;
        }
      }
      const id = randomId('R');
      const orderNumber = `GL${new Date(now).toISOString().slice(0, 10).replaceAll('-', '')}${randomInt(10000, 99999)}`;
      const won = Boolean(prize);
      const snapshot = won ? {
        id: prize.id,
        name: prize.name,
        specification: prize.specification,
        level: prize.level,
        category: prize.category,
        valueCents: prize.value_cents,
        image: prize.image,
        exchangeCents: Number((await queryOne(this.db, 'SELECT exchange_cents FROM prize_reward_rules WHERE prize_id=?', prize.id))?.exchange_cents || 0),
        selectedCard
      } : { selectedCard };
      const expiresAt = won ? now + setting.prize_valid_days * DAY : null;
      await execute(this.db, `INSERT INTO redemptions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '', '', ?, ?, NULL, ?)`, id, orderNumber, code, codeRow.batch_id, codeRow.pool_id, customerId, won ? prize.id : null, won ? 1 : 0, won ? 'pending' : 'lose', JSON.stringify(snapshot), prize?.category === 'cash' ? null : (store?.id || null), now, expiresAt, now);
      const codeUpdate = await execute(this.db, "UPDATE redeem_codes SET status='redeemed', redeemed_at=?, redemption_id=? WHERE code=? AND status='unused'", now, id, code);
      assert(Number(codeUpdate.changes) === 1, 409, 'ERR_USED', '该兑换码已被使用，同一卡密仅可兑奖一次');
      if (won) {
        await this.notice(customerId, 'win', '恭喜中奖', `您通过兑换码 ${code} 抽中「${prize.name}」，${prize.category === 'cash' ? '请在有效期内打开红包凭证领取到微信零钱。' : prize.category === 'exchange' ? '请到店支付换购金额后核销领取一袋。' : setting.prize_valid_days + ' 天内到店核销有效。'}`, code);
        if (prize.stock - 1 <= prize.low_stock_threshold) {
          await this.audit({
            actorType: 'system',
            action: 'low_stock_alert',
            entityType: 'prize',
            entityId: prize.id,
            result: '库存预警',
            detail: {
              remaining: Math.max(0, prize.stock - 1),
              threshold: prize.low_stock_threshold
            }
          });
        }
      } else {
        await this.notice(customerId, 'result', '谢谢惠顾', '本次未中奖，感谢参与倌榔活动。', code);
      }
      await this.audit({
        actorType: 'customer',
        actorId: customer.id,
        actorName: customer.nickname,
        action: 'redeem',
        entityType: 'redemption',
        entityId: id,
        ip,
        result: won ? '中奖' : '未中奖',
        detail: {
          code,
          batchId: codeRow.batch_id,
          prizeId: prize?.id || null,
          stockOut
        }
      });
      const row = await queryOne(this.db, redemptionJoin + ' WHERE r.id=?', id);
      return {
        ok: true,
        code: won ? 'OK_WIN' : 'OK_LOSE',
        msg: won ? '恭喜中奖' : '谢谢惠顾',
        stockOut,
        record: redemptionView(row)
      };
    });
  }
  async changePreferredStore(customerId, recordId, storeId) {
    const store = await queryOne(this.db, "SELECT * FROM stores WHERE id=? AND status='active'", storeId);
    assert(store, 404, 'ERR_STORE_NOT_FOUND', '门店不存在或已停用');
    const result = await execute(this.db, "UPDATE redemptions SET preferred_store_id=?, updated_at=? WHERE id=? AND customer_id=? AND status='pending'", storeId, Date.now(), recordId, customerId);
    assert(Number(result.changes) === 1, 409, 'ERR_RECORD_STATE', '仅待核销订单可以更换领取门店');
    return storeView(store);
  }
  async customerCoupons(customerId) {
    const now = Date.now();
    await execute(this.db, "UPDATE coupons SET status='expired' WHERE customer_id=? AND status='valid' AND expires_at<=?", customerId, now);
    return (await queryAll(this.db, 'SELECT * FROM coupons WHERE customer_id=? ORDER BY created_at DESC', customerId)).map(row => ({
      id: row.id,
      name: row.name,
      sub: row.subtitle,
      amount: row.amount_cents / 100,
      floor: row.minimum_cents / 100,
      status: row.status,
      from: row.source,
      at: row.created_at,
      expireAt: row.expires_at,
      usedAt: row.used_at,
      used: row.status === 'used'
    }));
  }
  async customerNotices(customerId) {
    return (await queryAll(this.db, 'SELECT * FROM notices WHERE customer_id=? ORDER BY created_at DESC', customerId)).map(row => ({
      id: row.id,
      type: row.type,
      title: row.title,
      desc: row.description,
      link: row.link_code,
      read: Boolean(row.read),
      at: row.created_at
    }));
  }
  async readNotice(customerId, noticeId = null) {
    if (noticeId) await execute(this.db, 'UPDATE notices SET `read`=1 WHERE id=? AND customer_id=?', noticeId, customerId);else await execute(this.db, 'UPDATE notices SET `read`=1 WHERE customer_id=?', customerId);
    return {
      ok: true
    };
  }
  async storeLogin(username, password, ip = '') {
    const row = await queryOne(this.db, `SELECT sa.*, s.short_name AS store_name FROM store_accounts sa LEFT JOIN stores s ON s.id=sa.store_id WHERE sa.username=?`, requiredText(username, '账号', 80));
    assert(row && row.active && verifyPassword(String(password || ''), row.password_hash), 401, 'ERR_LOGIN', '账号或密码错误');
    const now = Date.now();
    await execute(this.db, 'UPDATE store_accounts SET last_login_at=?, updated_at=? WHERE id=?', now, now, row.id);
    await this.audit({
      actorType: 'store',
      actorId: row.id,
      actorName: row.name,
      action: 'login',
      entityType: 'account',
      entityId: row.id,
      storeId: row.store_id,
      ip,
      result: '登录成功'
    });
    return {
      token: signToken({
        sub: row.id,
        type: 'store',
        role: row.role,
        storeId: row.store_id
      }, this.config.tokenSecret, 12 * 60 * 60),
      account: accountView({
        ...row,
        last_login_at: now
      })
    };
  }
  async storeAccount(id) {
    const row = await queryOne(this.db, 'SELECT sa.*, s.short_name AS store_name FROM store_accounts sa LEFT JOIN stores s ON s.id=sa.store_id WHERE sa.id=? AND sa.active=1', id);
    assert(row, 401, 'ERR_AUTH', '门店账号不存在或已停用');
    return row;
  }
  async storeBootstrap(accountId) {
    await this.expireOrders();
    const account = await this.storeAccount(accountId);
    return {
      account: accountView(account),
      store: account.store_id ? storeView(await queryOne(this.db, 'SELECT * FROM stores WHERE id=?', account.store_id)) : null,
      canViewData: account.role === 'owner' || account.role === 'hq',
      stats: await this.storeStats(account),
      pending: await this.storeOrders(account, {
        status: 'pending',
        page: '1',
        pageSize: '6'
      })
    };
  }
  async storeOrders(account, query = {}) {
    await this.expireOrders();
    const {
      page,
      pageSize
    } = parsePage(query);
    const values = [];
    let where = ' WHERE r.won=1';
    if (account.role !== 'hq') {
      where += ' AND (r.preferred_store_id=? OR r.verified_store_id=?)';
      values.push(account.store_id, account.store_id);
    }
    if (query.status && query.status !== 'all') {
      assert(new Set(['pending', 'verified', 'expired', 'frozen']).has(query.status), 400, 'ERR_STATUS', '订单状态不正确');
      where += ' AND r.status=?';
      values.push(query.status);
    }
    if (query.keyword) {
      where += ' AND (r.code LIKE ? OR r.order_no LIKE ? OR c.nickname LIKE ? OR c.phone LIKE ?)';
      const keyword = `%${text(query.keyword, 80)}%`;
      values.push(keyword, keyword, keyword, keyword);
    }
    const total = (await queryOne(this.db, `SELECT COUNT(*) AS total FROM redemptions r JOIN customers c ON c.id=r.customer_id ${where}`, ...values)).total;
    const rows = await queryAll(this.db, redemptionJoin + where + ' ORDER BY COALESCE(r.verified_at,r.redeemed_at) DESC LIMIT ? OFFSET ?', ...values, pageSize, (page - 1) * pageSize);
    return paged(rows.map(redemptionView), total, page, pageSize);
  }
  async storeOrderRows(account) {
    await this.expireOrders();
    const values = [];
    let where = ' WHERE r.won=1';
    if (account.role !== 'hq') {
      where += ' AND (r.preferred_store_id=? OR r.verified_store_id=?)';
      values.push(account.store_id, account.store_id);
    }
    return (await queryAll(this.db, redemptionJoin + where + ' ORDER BY COALESCE(r.verified_at,r.redeemed_at) DESC', ...values)).map(redemptionView);
  }
  async verifyLookup(account, codeValue, shouldExpire = true) {
    if (shouldExpire) await this.expireOrders();
    const code = String(codeValue || '').trim().toUpperCase();
    assert(/^[A-Z0-9]{6}$/.test(code), 400, 'ERR_FORMAT', '请输入 6 位核销码');
    const row = await queryOne(this.db, redemptionJoin + ' WHERE r.code=?', code);
    assert(row, 404, 'ERR_NOT_FOUND', '未查询到该兑换码对应的订单');
    const record = redemptionView(row);
    assert(record.prizeType !== 'cash', 409, 'ERR_CASH_STORE', '现金红包由顾客在微信领取，门店不可核销');
    assert(record.win, 409, 'ERR_NOT_WIN', '该兑换码本次未中奖，无需核销');
    if (record.status === 'verified') throw Object.assign(apiError(409, 'ERR_DUP', `该订单已在「${record.storeName}」核销`), {
      record
    });
    assert(record.status !== 'expired', 409, 'ERR_EXPIRED', '该订单已超过有效期，系统已自动失效');
    assert(record.status !== 'frozen', 409, 'ERR_FROZEN', `该订单已被总部冻结：${record.frozenReason}`);
    return {
      ok: true,
      code: 'OK',
      msg: '可核销',
      record
    };
  }
  async verify(account, codeValue, position, ip = '', exchangePaid = false) {
    const code = String(codeValue || '').trim().toUpperCase();
    await this.expireOrders();
    try {
      return await transaction(this.db, async () => {
        const record = (await this.verifyLookup(account, code, false)).record;
        assert(record.prizeType !== 'exchange' || exchangePaid === true, 409, 'ERR_EXCHANGE_PAYMENT', '请先确认已收取换购金额并交付一袋商品');
        const now = Date.now();
        let storeId = account.store_id;
        if (account.role === 'hq') storeId = record.preferStoreId || (await queryOne(this.db, "SELECT id FROM stores WHERE status='active' ORDER BY id LIMIT 1"))?.id;
        const store = await queryOne(this.db, "SELECT * FROM stores WHERE id=? AND status='active'", storeId);
        assert(store, 409, 'ERR_STORE_DISABLED', '当前核销门店不可用');
        const finalPosition = text(position, 300) || `${store.address}（门店定位）`;
        const changed = await execute(this.db, "UPDATE redemptions SET status='verified', verified_store_id=?, verified_by_account_id=?, verified_position=?, verified_at=?, updated_at=? WHERE id=? AND status='pending'", store.id, account.id, finalPosition, now, now, record.id);
        assert(Number(changed.changes) === 1, 409, 'ERR_DUP', '订单状态已变化，请刷新后重试');
        await execute(this.db, "UPDATE redeem_codes SET status='verified' WHERE redemption_id=?", record.id);
        if (record.prizeId) await execute(this.db, 'UPDATE prizes SET sent_count=sent_count+1, updated_at=? WHERE id=?', now, record.prizeId);
        await this.notice(record.userId, 'verify', '核销完成', `您的「${record.prizeName}」已在${store.short_name}完成核销。`, code);
        await this.audit({
          actorType: 'store',
          actorId: account.id,
          actorName: account.name + (account.role === 'hq' ? '（总部代核销）' : ''),
          action: 'verify',
          entityType: 'redemption',
          entityId: record.id,
          storeId: store.id,
          ip,
          position: finalPosition,
          result: '核销成功',
          detail: {
            code,
            prizeId: record.prizeId
          }
        });
        return {
          ok: true,
          code: 'OK',
          msg: '核销成功',
          record: redemptionView(await queryOne(this.db, redemptionJoin + ' WHERE r.id=?', record.id))
        };
      });
    } catch (error) {
      if (error.code === 'ERR_DUP') {
        const record = error.record || redemptionView(await queryOne(this.db, redemptionJoin + ' WHERE r.code=?', code));
        await this.audit({
          actorType: 'store',
          actorId: account.id,
          actorName: account.name,
          action: 'verify_blocked',
          entityType: 'redemption',
          entityId: record?.id || '',
          storeId: account.store_id || record?.storeId || null,
          ip,
          position: text(position, 300),
          result: '重复核销已拦截',
          detail: {
            code
          }
        });
      }
      throw error;
    }
  }
  async storeStats(account) {
    const values = [];
    const storeWhere = account.role === 'hq' ? '' : ' AND (preferred_store_id=? OR verified_store_id=?)';
    if (account.role !== 'hq') values.push(account.store_id, account.store_id);
    const today = utcDayStart();
    const stats = await queryOne(this.db, `SELECT
      SUM(CASE WHEN redeemed_at>=? THEN 1 ELSE 0 END) AS today_redeem,
      SUM(CASE WHEN redeemed_at>=? AND won=1 THEN 1 ELSE 0 END) AS today_win,
      SUM(CASE WHEN verified_at>=? AND status='verified' THEN 1 ELSE 0 END) AS today_verify,
      SUM(CASE WHEN won=1 THEN 1 ELSE 0 END) AS total_win,
      COUNT(*) AS total_redeem,
      SUM(CASE WHEN status='verified' THEN 1 ELSE 0 END) AS total_verify,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='verified' THEN CAST(json_extract(prize_snapshot_json,'$.valueCents') AS SIGNED) ELSE 0 END) AS total_value
      FROM redemptions WHERE 1=1 ${storeWhere}`, today, today, today, ...values);
    const totalRedeem = Number(stats.total_redeem || 0);
    return {
      todayRedeem: Number(stats.today_redeem || 0),
      todayWin: Number(stats.today_win || 0),
      todayVerify: Number(stats.today_verify || 0),
      winRate: totalRedeem ? Math.round(Number(stats.total_win || 0) / totalRedeem * 1000) / 10 : 0,
      totalVerify: Number(stats.total_verify || 0),
      pending: Number(stats.pending || 0),
      totalValue: Number(stats.total_value || 0) / 100
    };
  }
  async storeTrend(account) {
    const output = [];
    for (let index = 6; index >= 0; index--) {
      const start = utcDayStart() - index * DAY;
      const end = start + DAY;
      const row = account.role === 'hq' ? await queryOne(this.db, "SELECT COUNT(*) AS count FROM redemptions WHERE status='verified' AND verified_at>=? AND verified_at<?", start, end) : await queryOne(this.db, "SELECT COUNT(*) AS count FROM redemptions WHERE status='verified' AND verified_store_id=? AND verified_at>=? AND verified_at<?", account.store_id, start, end);
      const date = new Date(start);
      output.push({
        label: `${date.getUTCMonth() + 1}/${date.getUTCDate()}`,
        value: Number(row.count),
        today: index === 0
      });
    }
    return output;
  }
  async storeRank(account) {
    return (await queryAll(this.db, `SELECT s.id, s.short_name, s.image,
      COUNT(r.id) AS total,
      SUM(CASE WHEN r.verified_at>=? THEN 1 ELSE 0 END) AS today
      FROM stores s LEFT JOIN redemptions r ON r.verified_store_id=s.id AND r.status='verified'
      WHERE s.status='active' GROUP BY s.id ORDER BY total DESC, s.id`, utcDayStart())).map(row => ({
      id: row.id,
      name: row.short_name,
      img: row.image,
      total: Number(row.total),
      today: Number(row.today || 0),
      mine: row.id === account.store_id
    }));
  }
  async storeLogs(account, query = {}) {
    assert(account.role !== 'staff', 403, 'ERR_PERMISSION', '店员无日志查看权限');
    const {
      page,
      pageSize
    } = parsePage(query);
    const params = [];
    let where = " WHERE actor_type='store'";
    if (account.role !== 'hq') {
      where += ' AND store_id=?';
      params.push(account.store_id);
    }
    if (query.type === 'verify') where += " AND action='verify'";
    if (query.type === 'block') where += " AND action='verify_blocked'";
    const total = (await queryOne(this.db, 'SELECT COUNT(*) AS total FROM audit_logs' + where, ...params)).total;
    const rows = await queryAll(this.db, 'SELECT * FROM audit_logs' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?', ...params, pageSize, (page - 1) * pageSize);
    return paged(rows.map(row => this.auditView(row)), total, page, pageSize);
  }
  async storePrizeLibrary() {
    return (await queryAll(this.db, 'SELECT p.*, rr.exchange_cents, pp.name AS pool_name FROM prizes p JOIN prize_pools pp ON pp.id=p.pool_id LEFT JOIN prize_reward_rules rr ON rr.prize_id=p.id ORDER BY p.value_cents DESC')).map(row => prizeView(row));
  }
  async storeStaff(account) {
    assert(account.role === 'owner' || account.role === 'hq', 403, 'ERR_PERMISSION', '无员工管理权限');
    const storeId = account.store_id;
    return (await queryAll(this.db, 'SELECT sa.*, s.short_name AS store_name FROM store_accounts sa LEFT JOIN stores s ON s.id=sa.store_id WHERE sa.store_id=? ORDER BY sa.role, sa.created_at', storeId)).map(accountView);
  }
  async createStoreStaff(account, body) {
    assert(account.role === 'owner' || account.role === 'hq', 403, 'ERR_PERMISSION', '无员工管理权限');
    const storeId = account.role === 'hq' ? requiredText(body.storeId, '门店', 50) : account.store_id;
    assert(await queryOne(this.db, "SELECT id FROM stores WHERE id=? AND status='active'", storeId), 404, 'ERR_STORE_NOT_FOUND', '门店不存在');
    const now = Date.now();
    const id = randomId('U');
    try {
      await execute(this.db, 'INSERT INTO store_accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)', id, storeId, requiredText(body.username, '登录账号', 80), hashPassword(accountPassword(body.password)), requiredText(body.name, '姓名', 80), text(body.phone, 30), text(body.avatar, 500), 'staff', JSON.stringify(['verify']), now, now);
    } catch (error) {
      uniqueConstraint(error, '登录账号已存在');
    }
    await this.audit({
      actorType: 'store',
      actorId: account.id,
      actorName: account.name,
      action: 'create_staff',
      entityType: 'store_account',
      entityId: id,
      storeId,
      result: '创建成功'
    });
    return accountView(await queryOne(this.db, 'SELECT sa.*, s.short_name AS store_name FROM store_accounts sa LEFT JOIN stores s ON s.id=sa.store_id WHERE sa.id=?', id));
  }
  async updateStoreStaff(account, staffId, body) {
    assert(account.role === 'owner' || account.role === 'hq', 403, 'ERR_PERMISSION', '无员工管理权限');
    const target = await queryOne(this.db, 'SELECT * FROM store_accounts WHERE id=?', staffId);
    assert(target && target.role === 'staff', 404, 'ERR_ACCOUNT_NOT_FOUND', '店员账号不存在');
    if (account.role !== 'hq') assert(target.store_id === account.store_id, 403, 'ERR_DATA_SCOPE', '不可管理其他门店账号');
    const name = body.name == null ? target.name : requiredText(body.name, '姓名', 80);
    const phone = body.phone == null ? target.phone : text(body.phone, 30);
    const active = body.active == null ? target.active : boolInt(body.active);
    const passwordHash = body.password ? hashPassword(String(body.password)) : target.password_hash;
    await execute(this.db, 'UPDATE store_accounts SET name=?, phone=?, active=?, password_hash=?, updated_at=? WHERE id=?', name, phone, active, passwordHash, Date.now(), staffId);
    await this.audit({
      actorType: 'store',
      actorId: account.id,
      actorName: account.name,
      action: 'update_staff',
      entityType: 'store_account',
      entityId: staffId,
      storeId: target.store_id,
      result: '更新成功'
    });
    return accountView(await queryOne(this.db, 'SELECT sa.*, s.short_name AS store_name FROM store_accounts sa LEFT JOIN stores s ON s.id=sa.store_id WHERE sa.id=?', staffId));
  }
  async adminLogin(username, password, ip = '') {
    const row = await queryOne(this.db, 'SELECT * FROM admin_users WHERE username=?', requiredText(username, '账号', 80));
    assert(row && row.active && verifyPassword(String(password || ''), row.password_hash), 401, 'ERR_LOGIN', '账号或密码错误');
    const now = Date.now();
    await execute(this.db, 'UPDATE admin_users SET last_login_at=?, updated_at=? WHERE id=?', now, now, row.id);
    await this.audit({
      actorType: 'admin',
      actorId: row.id,
      actorName: row.name,
      action: 'login',
      entityType: 'admin_user',
      entityId: row.id,
      ip,
      result: '登录成功'
    });
    return {
      token: signToken({
        sub: row.id,
        type: 'admin',
        role: row.role
      }, this.config.tokenSecret, 8 * 60 * 60),
      user: safeUser({
        ...row,
        last_login_at: now
      })
    };
  }
  async adminUser(id) {
    const row = await queryOne(this.db, 'SELECT * FROM admin_users WHERE id=? AND active=1', id);
    assert(row, 401, 'ERR_AUTH', '管理账号不存在或已停用');
    return row;
  }
  async adminMe(admin) {
    return safeUser(admin);
  }
  assertAdminWrite(admin) {
    assert(WRITE_ADMIN_ROLES.has(admin.role), 403, 'ERR_PERMISSION', '当前账号只有只读权限');
  }
  assertStoreAdminWrite(admin) {
    assert(STORE_ADMIN_ROLES.has(admin.role), 403, 'ERR_PERMISSION', '当前账号没有门店管理权限');
  }
  assertSuperAdmin(admin) {
    assert(admin.role === 'super_admin', 403, 'ERR_PERMISSION', '仅超级管理员可以管理销售账号');
  }
  async storeForAdmin(admin, id) {
    const row = await queryOne(this.db, 'SELECT * FROM stores WHERE id=?', id);
    assert(row, 404, 'ERR_STORE_NOT_FOUND', '门店不存在');
    if (admin.role === 'sales') {
      assert(row.created_by_admin_id === admin.id, 403, 'ERR_DATA_SCOPE', '只能查看和管理自己创建的门店');
    }
    return row;
  }
  async salesUsers(admin) {
    this.assertSuperAdmin(admin);
    return (await queryAll(this.db, `SELECT au.*,
      (SELECT COUNT(*) FROM stores s WHERE s.created_by_admin_id=au.id) AS store_count
      FROM admin_users au WHERE au.role='sales' ORDER BY au.created_at DESC`)).map(row => ({
      id: row.id,
      username: row.username,
      name: row.name,
      role: row.role,
      active: Boolean(row.active),
      lastLoginAt: row.last_login_at,
      storeCount: Number(row.store_count || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }
  async saveSalesUser(admin, id, body, ip = '') {
    this.assertSuperAdmin(admin);
    const current = id ? await queryOne(this.db, "SELECT * FROM admin_users WHERE id=? AND role='sales'", id) : null;
    if (id) assert(current, 404, 'ERR_SALES_NOT_FOUND', '销售账号不存在');
    const now = Date.now();
    const finalId = id || randomId('A');
    const username = body.username == null ? current?.username : requiredText(body.username, '登录账号', 80);
    const name = body.name == null ? current?.name : requiredText(body.name, '销售姓名', 100);
    const active = body.active == null ? current?.active ?? 1 : boolInt(body.active);
    const passwordHash = body.password ? hashPassword(accountPassword(body.password)) : current?.password_hash;
    assert(passwordHash, 400, 'ERR_PASSWORD', '创建销售账号时必须设置初始密码');
    try {
      if (current) {
        await execute(this.db, 'UPDATE admin_users SET username=?,password_hash=?,name=?,active=?,updated_at=? WHERE id=?', username, passwordHash, name, active, now, id);
      } else {
        await execute(this.db, "INSERT INTO admin_users (id,username,password_hash,name,role,active,last_login_at,created_at,updated_at) VALUES (?,?,?,?,'sales',?,NULL,?,?)", finalId, username, passwordHash, name, active, now, now);
      }
    } catch (error) {
      uniqueConstraint(error, '管理后台登录账号已存在');
    }
    await this.audit({
      actorType: 'admin',
      actorId: admin.id,
      actorName: admin.name,
      action: current ? 'update_sales_account' : 'create_sales_account',
      entityType: 'admin_user',
      entityId: finalId,
      ip,
      result: current ? '更新成功' : '创建成功',
      detail: { username, name, active: Boolean(active) }
    });
    return (await this.salesUsers(admin)).find(item => item.id === finalId);
  }
  async adminDashboard() {
    await this.expireOrders();
    const totals = await queryOne(this.db, `SELECT
      COUNT(*) AS redeemed,
      SUM(CASE WHEN won=1 THEN 1 ELSE 0 END) AS won,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='verified' THEN 1 ELSE 0 END) AS verified,
      SUM(CASE WHEN status='frozen' THEN 1 ELSE 0 END) AS frozen
      FROM redemptions`);
    const codeStats = await queryAll(this.db, 'SELECT status, COUNT(*) AS count FROM redeem_codes GROUP BY status');
    const lowStock = (await queryAll(this.db, `SELECT p.*, rr.exchange_cents, pp.name AS pool_name FROM prizes p JOIN prize_pools pp ON pp.id=p.pool_id LEFT JOIN prize_reward_rules rr ON rr.prize_id=p.id WHERE p.status='active' AND p.stock<=p.low_stock_threshold ORDER BY p.stock`)).map(prizeView);
    const stores = (await queryAll(this.db, `SELECT s.id, s.short_name, COUNT(r.id) AS verified FROM stores s LEFT JOIN redemptions r ON r.verified_store_id=s.id AND r.status='verified' GROUP BY s.id ORDER BY verified DESC`)).map(row => ({
      id: row.id,
      name: row.short_name,
      verified: Number(row.verified)
    }));
    return {
      totals: {
        redeemed: Number(totals.redeemed || 0),
        won: Number(totals.won || 0),
        pending: Number(totals.pending || 0),
        verified: Number(totals.verified || 0),
        frozen: Number(totals.frozen || 0),
        winRate: Number(totals.redeemed) ? Math.round(Number(totals.won || 0) / Number(totals.redeemed) * 1000) / 10 : 0
      },
      codeStats: Object.fromEntries(codeStats.map(row => [row.status, Number(row.count)])),
      lowStock,
      storeRank: stores,
      recent: (await queryAll(this.db, redemptionJoin + ' ORDER BY r.redeemed_at DESC LIMIT 8')).map(redemptionView)
    };
  }
  async updateSettings(admin, body, ip = '') {
    this.assertAdminWrite(admin);
    const current = await this.settingsRow();
    const now = Date.now();
    let noticeJson = current.notice_json;
    if (body.notice != null) {
      assert(body.notice && typeof body.notice === 'object' && !Array.isArray(body.notice), 400, 'ERR_NOTICE', '入场弹窗配置格式不正确');
      const lines = Array.isArray(body.notice.lines) ? body.notice.lines : [];
      assert(lines.length <= 20, 400, 'ERR_NOTICE', '入场弹窗最多填写 20 条内容');
      const date = text(body.notice.date, 10);
      assert(!date || /^\d{4}-\d{2}-\d{2}$/.test(date), 400, 'ERR_NOTICE_DATE', '入场弹窗日期格式不正确');
      noticeJson = JSON.stringify({
        enabled: Boolean(body.notice.enabled ?? body.notice.on),
        badge: requiredText(body.notice.badge ?? '公告', '弹窗角标', 12),
        buttonText: requiredText(body.notice.buttonText ?? '我知道了', '弹窗按钮文字', 20),
        image: text(body.notice.image, 500),
        title: text(body.notice.title, 80),
        date,
        lines: lines.map((line) => text(line, 180)).filter(Boolean)
      });
    }
    let flowJson = current.flow_json;
    if (body.flow != null) {
      assert(Array.isArray(body.flow) && body.flow.length === 4, 400, 'ERR_FLOW', '兑奖操作说明必须包含 4 个步骤');
      flowJson = JSON.stringify(body.flow.map((step, index) => {
        assert(step && typeof step === 'object' && !Array.isArray(step), 400, 'ERR_FLOW', `第 ${index + 1} 步格式不正确`);
        return {
          no: String(index + 1).padStart(2, '0'),
          icon: text(step.icon, 40),
          title: requiredText(step.title ?? step.t, `第 ${index + 1} 步标题`, 40),
          description: requiredText(step.description ?? step.d, `第 ${index + 1} 步说明`, 160)
        };
      }));
    }
    let serviceJson = current.service_json;
    if (body.service != null) {
      assert(body.service && typeof body.service === 'object' && !Array.isArray(body.service), 400, 'ERR_SERVICE', '客服配置格式不正确');
      const phone = text(body.service.phone, 40);
      const wechat = text(body.service.wechat, 80);
      assert(phone || wechat, 400, 'ERR_SERVICE_CONTACT', '客服电话和客服微信至少填写一项');
      serviceJson = JSON.stringify({
        phone,
        wechat,
        time: text(body.service.time ?? body.service.hours, 80),
        note: text(body.service.note, 300)
      });
    }
    const brandMark = body.brandMark == null ? current.brand_mark : requiredText(body.brandMark, '品牌方块标识', 8);
    assert(Array.from(brandMark).length <= 2, 400, 'ERR_BRAND_MARK', '品牌方块标识最多填写 2 个字符');
    const next = {
      brand: body.brand == null ? current.brand : requiredText(body.brand, '品牌名称', 80),
      brandEn: body.brandEn == null ? current.brand_en : text(body.brandEn, 80),
      brandMark,
      brandLogo: body.brandLogo == null ? current.brand_logo : text(body.brandLogo, 500),
      adminSubtitle: body.adminSubtitle == null ? current.admin_subtitle : requiredText(body.adminSubtitle, '后台副标题', 80),
      actName: body.actName == null ? current.activity_name : requiredText(body.actName, '活动名称', 100),
      actSub: body.actSub == null ? current.activity_subtitle : text(body.actSub, 120),
      slogan: body.slogan == null ? current.slogan : text(body.slogan, 120),
      active: body.active == null ? current.active : boolInt(body.active),
      start: body.actStart == null ? current.activity_start : requiredText(body.actStart, '开始日期', 10),
      end: body.actEnd == null ? current.activity_end : requiredText(body.actEnd, '结束日期', 10),
      daily: body.dailyLimit == null ? current.daily_limit : integer(body.dailyLimit, '每日兑奖次数', 0, 20),
      valid: body.prizeValidDays == null ? current.prize_valid_days : integer(body.prizeValidDays, '领奖有效期', 1, 365),
      homeBg: body.homeBg == null ? current.home_bg : text(body.homeBg, 500),
      poster: body.poster == null ? current.poster : text(body.poster, 500),
      product: body.productImg == null ? current.product_image : text(body.productImg, 500),
      ruleBg: body.ruleBg == null ? current.rule_bg : text(body.ruleBg, 500),
      notice: noticeJson,
      flow: flowJson,
      service: serviceJson
    };
    assert(/^\d{4}-\d{2}-\d{2}$/.test(next.start) && /^\d{4}-\d{2}-\d{2}$/.test(next.end) && next.end >= next.start, 400, 'ERR_DATE_RANGE', '活动日期范围不正确');
    await execute(this.db, `UPDATE settings SET brand=?,brand_en=?,brand_mark=?,brand_logo=?,admin_subtitle=?,activity_name=?,activity_subtitle=?,slogan=?,active=?,activity_start=?,activity_end=?,daily_limit=?,prize_valid_days=?,home_bg=?,poster=?,product_image=?,rule_bg=?,notice_json=?,flow_json=?,service_json=?,updated_at=? WHERE id=1`, next.brand, next.brandEn, next.brandMark, next.brandLogo, next.adminSubtitle, next.actName, next.actSub, next.slogan, next.active, next.start, next.end, next.daily, next.valid, next.homeBg, next.poster, next.product, next.ruleBg, next.notice, next.flow, next.service, now);
    await this.audit({
      actorType: 'admin',
      actorId: admin.id,
      actorName: admin.name,
      action: 'update_settings',
      entityType: 'settings',
      entityId: '1',
      ip,
      result: '更新成功'
    });
    return settingView(await this.settingsRow());
  }
  async pools() {
    return (await queryAll(this.db, `SELECT pp.*,
      (SELECT COUNT(*) FROM prizes p WHERE p.pool_id=pp.id) AS prize_count,
      (SELECT COUNT(*) FROM batches b WHERE b.pool_id=pp.id) AS batch_count,
      (SELECT COUNT(*) FROM redeem_codes rc JOIN batches b ON b.id=rc.batch_id WHERE b.pool_id=pp.id) AS code_count,
      (SELECT COUNT(*) FROM redemptions r WHERE r.pool_id=pp.id) AS redemption_count
      FROM prize_pools pp ORDER BY pp.created_at DESC`)).map(row => ({
      ...poolView(row),
      prizeCount: Number(row.prize_count),
      batchCount: Number(row.batch_count),
      codeCount: Number(row.code_count),
      redemptionCount: Number(row.redemption_count)
    }));
  }
  async savePool(admin, id, body, ip = '') {
    this.assertAdminWrite(admin);
    const current = id ? await queryOne(this.db, 'SELECT * FROM prize_pools WHERE id=?', id) : null;
    if (id) assert(current, 404, 'ERR_POOL_NOT_FOUND', '奖池不存在');
    const now = Date.now();
    const finalId = id || randomId('POOL');
    const values = {
      name: body.name == null ? current?.name : requiredText(body.name, '奖池名称', 80),
      desc: body.desc == null ? current?.description || '' : text(body.desc, 300),
      tier: body.tier == null ? current?.tier_label || '' : text(body.tier, 80),
      status: body.status == null ? current?.status || 'active' : text(body.status, 20)
    };
    assert(PRIZE_STATUSES.has(values.status), 400, 'ERR_STATUS', '奖池状态不正确');
    try {
      if (current) await execute(this.db, 'UPDATE prize_pools SET name=?,description=?,tier_label=?,status=?,updated_at=? WHERE id=?', values.name, values.desc, values.tier, values.status, now, id);else await execute(this.db, 'INSERT INTO prize_pools VALUES (?, ?, ?, ?, ?, ?, ?)', finalId, values.name, values.desc, values.tier, values.status, now, now);
    } catch (error) {
      uniqueConstraint(error, '奖池名称已存在');
    }
    await this.audit({
      actorType: 'admin',
      actorId: admin.id,
      actorName: admin.name,
      action: current ? 'update_pool' : 'create_pool',
      entityType: 'pool',
      entityId: finalId,
      ip,
      result: '保存成功'
    });
    return poolView(await queryOne(this.db, 'SELECT * FROM prize_pools WHERE id=?', finalId));
  }
  async deletePool(admin, id, ip = '') {
    this.assertAdminWrite(admin);
    const current = await queryOne(this.db, 'SELECT * FROM prize_pools WHERE id=?', id);
    assert(current, 404, 'ERR_POOL_NOT_FOUND', '奖池不存在或已被删除');
    const stats = await queryOne(this.db, `SELECT
      (SELECT COUNT(*) FROM prizes WHERE pool_id=?) AS prize_count,
      (SELECT COUNT(*) FROM batches WHERE pool_id=?) AS batch_count,
      (SELECT COUNT(*) FROM redeem_codes rc JOIN batches b ON b.id=rc.batch_id WHERE b.pool_id=?) AS code_count,
      (SELECT COUNT(*) FROM redemptions WHERE pool_id=?) AS redemption_count`, id, id, id, id);
    const redemptionCount = Number(stats.redemption_count || 0);
    assert(redemptionCount === 0, 409, 'ERR_POOL_HAS_HISTORY', `该奖池已有 ${redemptionCount} 条兑奖或核销记录，为保护正式历史数据不能删除；请将奖池状态改为停用`);
    const deleted = {
      prizes: Number(stats.prize_count || 0),
      batches: Number(stats.batch_count || 0),
      codes: Number(stats.code_count || 0)
    };
    await transaction(this.db, async () => {
      await execute(this.db, 'DELETE rc FROM redeem_codes rc JOIN batches b ON b.id=rc.batch_id WHERE b.pool_id=?', id);
      await execute(this.db, 'DELETE FROM batches WHERE pool_id=?', id);
      await execute(this.db, 'DELETE FROM prizes WHERE pool_id=?', id);
      await execute(this.db, 'DELETE FROM prize_pools WHERE id=?', id);
      await this.audit({
        actorType: 'admin',
        actorId: admin.id,
        actorName: admin.name,
        action: 'delete_pool',
        entityType: 'pool',
        entityId: id,
        ip,
        result: '删除成功',
        detail: { name: current.name, ...deleted }
      });
    });
    return { id, name: current.name, deleted };
  }
  async prizes(query = {}) {
    const params = [];
    let where = ' WHERE 1=1';
    if (query.poolId) {
      where += ' AND p.pool_id=?';
      params.push(query.poolId);
    }
    if (query.status) {
      where += ' AND p.status=?';
      params.push(query.status);
    }
    if (query.keyword) {
      where += ' AND p.name LIKE ?';
      params.push(`%${text(query.keyword, 80)}%`);
    }
    return (await queryAll(this.db, `SELECT p.*, rr.exchange_cents, pp.name AS pool_name FROM prizes p JOIN prize_pools pp ON pp.id=p.pool_id LEFT JOIN prize_reward_rules rr ON rr.prize_id=p.id ${where} ORDER BY p.created_at DESC`, ...params)).map(prizeView);
  }
  async savePrize(admin, id, body, ip = '') {
    return transaction(this.db, async () => {
    this.assertAdminWrite(admin);
    const current = id ? await queryOne(this.db, 'SELECT * FROM prizes WHERE id=?', id) : null;
    if (id) assert(current, 404, 'ERR_PRIZE_NOT_FOUND', '奖品不存在');
    const now = Date.now();
    const finalId = id || randomId('PZ');
    const poolId = body.poolId == null ? current?.pool_id : requiredText(body.poolId, '所属奖池', 50);
    assert(await queryOne(this.db, 'SELECT id FROM prize_pools WHERE id=?', poolId), 404, 'ERR_POOL_NOT_FOUND', '奖池不存在');
    const status = body.status == null ? current?.status || 'active' : text(body.status, 20);
    assert(PRIZE_STATUSES.has(status), 400, 'ERR_STATUS', '奖品状态不正确');
    const category = body.type == null ? current?.category || 'goods' : text(body.type, 30);
    assert(new Set(['goods', 'exchange', 'cash', 'coupon']).has(category), 400, 'ERR_PRIZE_TYPE', '奖品类型不正确');
    const oldRule = current ? await queryOne(this.db, 'SELECT exchange_cents FROM prize_reward_rules WHERE prize_id=?', id) : null;
    const exchangeCents = category === 'exchange' ? integer(body.exchangeCents ?? oldRule?.exchange_cents ?? 0, '换购补款金额', 1, 10000000) : 0;
    const valueCents = body.valueCents ?? current?.value_cents ?? 0;
    assert(category !== 'exchange' || exchangeCents < valueCents, 400, 'ERR_EXCHANGE_AMOUNT', '换购补款金额必须小于整袋商品价值');
    assert(category !== 'cash' || (valueCents > 0 && valueCents <= this.config.transfer.maxCents), 400, 'ERR_CASH_AMOUNT', '红包金额必须在已配置的单笔范围内');
    const row = [poolId, body.name == null ? current?.name : requiredText(body.name, '奖品名称', 100), body.spec == null ? current?.specification || '' : text(body.spec, 100), body.level == null ? current?.level || '' : text(body.level, 50), body.type == null ? current?.category || 'goods' : text(body.type, 30), body.valueCents == null ? current?.value_cents : integer(body.valueCents, '奖品价值', 0, 100000000), body.stock == null ? current?.stock : integer(body.stock, '库存', 0, 100000000), body.sent == null ? current?.sent_count || 0 : integer(body.sent, '已发数量', 0, 100000000), body.lowStockThreshold == null ? current?.low_stock_threshold || 10 : integer(body.lowStockThreshold, '预警阈值', 0, 100000000), body.weight == null ? current?.weight || 1 : numberValue(body.weight, '抽奖权重', 0.0001, 100000), body.img == null ? current?.image || '' : text(body.img, 500), status];
    if (current) await execute(this.db, 'UPDATE prizes SET pool_id=?,name=?,specification=?,level=?,category=?,value_cents=?,stock=?,sent_count=?,low_stock_threshold=?,weight=?,image=?,status=?,updated_at=? WHERE id=?', ...row, now, id);else await execute(this.db, 'INSERT INTO prizes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', finalId, ...row, now, now);
    await execute(this.db, 'INSERT INTO prize_reward_rules (prize_id,exchange_cents) VALUES (?,?) ON DUPLICATE KEY UPDATE exchange_cents=VALUES(exchange_cents)', finalId, exchangeCents);
    await this.audit({
      actorType: 'admin',
      actorId: admin.id,
      actorName: admin.name,
      action: current ? 'update_prize' : 'create_prize',
      entityType: 'prize',
      entityId: finalId,
      ip,
      result: '保存成功'
    });
    return prizeView(await queryOne(this.db, 'SELECT p.*,rr.exchange_cents,pp.name AS pool_name FROM prizes p JOIN prize_pools pp ON pp.id=p.pool_id LEFT JOIN prize_reward_rules rr ON rr.prize_id=p.id WHERE p.id=?', finalId));
    });
  }
  async batches(query = {}) {
    const params = [];
    let where = ' WHERE 1=1';
    if (query.status) {
      where += ' AND b.status=?';
      params.push(query.status);
    }
    if (query.poolId) {
      where += ' AND b.pool_id=?';
      params.push(query.poolId);
    }
    return (await queryAll(this.db, `SELECT b.*,pp.name AS pool_name,
      COUNT(rc.code) AS code_total,
      SUM(CASE WHEN rc.status='unused' THEN 1 ELSE 0 END) AS unused,
      SUM(CASE WHEN rc.status='redeemed' THEN 1 ELSE 0 END) AS redeemed,
      SUM(CASE WHEN rc.status='verified' THEN 1 ELSE 0 END) AS verified,
      SUM(CASE WHEN rc.status='expired' THEN 1 ELSE 0 END) AS expired
      FROM batches b JOIN prize_pools pp ON pp.id=b.pool_id LEFT JOIN redeem_codes rc ON rc.batch_id=b.id ${where} GROUP BY b.id ORDER BY b.created_at DESC`, ...params)).map(row => this.batchView(row));
  }
  batchView(row) {
    return {
      id: row.id,
      name: row.name,
      productTier: row.product_tier,
      priceCents: row.price_cents,
      price: row.price_cents / 100,
      poolId: row.pool_id,
      poolName: row.pool_name || '',
      winRatePpm: row.win_rate_ppm,
      winRate: row.win_rate_ppm / 10000,
      status: row.status,
      startsAt: row.starts_at,
      expiresAt: row.expires_at,
      codeStats: {
        total: Number(row.code_total || 0),
        unused: Number(row.unused || 0),
        redeemed: Number(row.redeemed || 0),
        verified: Number(row.verified || 0),
        expired: Number(row.expired || 0)
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
  async saveBatch(admin, id, body, ip = '') {
    this.assertAdminWrite(admin);
    const current = id ? await queryOne(this.db, 'SELECT * FROM batches WHERE id=?', id) : null;
    if (id) assert(current, 404, 'ERR_BATCH_NOT_FOUND', '批次不存在');
    const now = Date.now();
    const finalId = id || requiredText(body.id, '批次编号', 40).toUpperCase();
    const poolId = body.poolId == null ? current?.pool_id : requiredText(body.poolId, '奖池', 50);
    assert(await queryOne(this.db, 'SELECT id FROM prize_pools WHERE id=?', poolId), 404, 'ERR_POOL_NOT_FOUND', '奖池不存在');
    const status = body.status == null ? current?.status || 'active' : text(body.status, 20);
    assert(BATCH_STATUSES.has(status), 400, 'ERR_STATUS', '批次状态不正确');
    const startsAt = body.startsAt == null ? current?.starts_at : Number(body.startsAt);
    const expiresAt = body.expiresAt == null ? current?.expires_at : Number(body.expiresAt);
    assert(Number.isFinite(startsAt) && Number.isFinite(expiresAt) && expiresAt > startsAt, 400, 'ERR_DATE_RANGE', '批次有效期不正确');
    const row = [body.name == null ? current?.name : requiredText(body.name, '批次名称', 100), body.productTier == null ? current?.product_tier : requiredText(body.productTier, '产品档位', 80), body.priceCents == null ? current?.price_cents : integer(body.priceCents, '产品价格', 0, 10000000), poolId, body.winRatePpm == null ? current?.win_rate_ppm : integer(body.winRatePpm, '中奖概率', 0, 1000000), status, startsAt, expiresAt];
    try {
      if (current) await execute(this.db, 'UPDATE batches SET name=?,product_tier=?,price_cents=?,pool_id=?,win_rate_ppm=?,status=?,starts_at=?,expires_at=?,updated_at=? WHERE id=?', ...row, now, id);else await execute(this.db, 'INSERT INTO batches VALUES (?,?,?,?,?,?,?,?,?,?,?)', finalId, ...row, now, now);
    } catch (error) {
      uniqueConstraint(error, '批次编号已存在');
    }
    await this.audit({
      actorType: 'admin',
      actorId: admin.id,
      actorName: admin.name,
      action: current ? 'update_batch' : 'create_batch',
      entityType: 'batch',
      entityId: finalId,
      ip,
      result: '保存成功'
    });
    return (await this.batches()).find(item => item.id === finalId);
  }
  async generateCodes(admin, batchId, count, ip = '') {
    this.assertAdminWrite(admin);
    const batch = await queryOne(this.db, 'SELECT * FROM batches WHERE id=?', batchId);
    assert(batch, 404, 'ERR_BATCH_NOT_FOUND', '批次不存在');
    const amount = integer(count, '生成数量', 1, 50000);
    const now = Date.now();
    const created = [];
    await transaction(this.db, async () => {
      const insert = (...params) => execute(this.db, 'INSERT IGNORE INTO redeem_codes VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL)', ...params);
      let attempts = 0;
      while (created.length < amount && attempts < amount * 20) {
        attempts++;
        const code = randomCode(6);
        const result = await insert(code, batchId, 'unused', now);
        if (Number(result.changes) === 1) created.push(code);
      }
      assert(created.length === amount, 500, 'ERR_CODE_GENERATION', '兑换码生成数量不足，请重试');
    });
    await this.audit({
      actorType: 'admin',
      actorId: admin.id,
      actorName: admin.name,
      action: 'generate_codes',
      entityType: 'batch',
      entityId: batchId,
      ip,
      result: `生成 ${amount} 个`,
      detail: {
        count: amount
      }
    });
    return {
      batchId,
      count: created.length,
      codes: created.slice(0, 100),
      truncated: created.length > 100
    };
  }
  async batchCodes(batchId, query = {}) {
    const batch = await queryOne(this.db, 'SELECT id FROM batches WHERE id=?', batchId);
    assert(batch, 404, 'ERR_BATCH_NOT_FOUND', '批次不存在');
    const {
      page,
      pageSize
    } = parsePage(query);
    const values = [batchId];
    let where = ' WHERE batch_id=?';
    if (query.status) {
      where += ' AND status=?';
      values.push(query.status);
    }
    if (query.keyword) {
      where += ' AND code LIKE ?';
      values.push(`%${text(query.keyword, 20).toUpperCase()}%`);
    }
    const total = (await queryOne(this.db, 'SELECT COUNT(*) AS total FROM redeem_codes' + where, ...values)).total;
    const rows = (await queryAll(this.db, 'SELECT * FROM redeem_codes' + where + ' ORDER BY created_at DESC,code LIMIT ? OFFSET ?', ...values, pageSize, (page - 1) * pageSize)).map(row => ({
      code: row.code,
      batchId: row.batch_id,
      status: row.status,
      createdAt: row.created_at,
      redeemedAt: row.redeemed_at,
      redemptionId: row.redemption_id
    }));
    return paged(rows, total, page, pageSize);
  }
  async stores(admin, query = {}) {
    const params = [];
    let where = ' WHERE 1=1';
    if (admin.role === 'sales') {
      where += ' AND s.created_by_admin_id=?';
      params.push(admin.id);
    }
    if (query.status) {
      where += ' AND s.status=?';
      params.push(query.status);
    }
    if (query.keyword) {
      where += ' AND (s.name LIKE ? OR s.address LIKE ?)';
      const k = `%${text(query.keyword, 80)}%`;
      params.push(k, k);
    }
    return (await queryAll(this.db, `SELECT s.*, creator.name AS created_by_name, creator.username AS created_by_username,
      (SELECT COUNT(*) FROM store_accounts sa WHERE sa.store_id=s.id) AS account_count,
      (SELECT COUNT(*) FROM redemptions rv WHERE rv.verified_store_id=s.id AND rv.status='verified') AS verified_count,
      (SELECT COUNT(*) FROM redemptions rr WHERE rr.preferred_store_id=s.id OR rr.verified_store_id=s.id OR EXISTS (
        SELECT 1 FROM store_accounts sa2 WHERE sa2.id=rr.verified_by_account_id AND sa2.store_id=s.id
      )) AS redemption_count
      FROM stores s LEFT JOIN admin_users creator ON creator.id=s.created_by_admin_id ${where} ORDER BY s.created_at DESC`, ...params)).map(row => ({
      ...storeView(row),
      createdByAdminId: row.created_by_admin_id || '',
      createdByName: row.created_by_name || '',
      createdByUsername: row.created_by_username || '',
      accountCount: Number(row.account_count),
      verifiedCount: Number(row.verified_count),
      redemptionCount: Number(row.redemption_count)
    }));
  }
  async saveStore(admin, id, body, ip = '') {
    this.assertStoreAdminWrite(admin);
    const current = id ? await this.storeForAdmin(admin, id) : null;
    const now = Date.now();
    const finalId = id || randomId('S');
    const status = body.status == null ? current?.status || 'active' : text(body.status, 20);
    assert(STORE_STATUSES.has(status), 400, 'ERR_STATUS', '门店状态不正确');
    const row = [body.name == null ? current?.name : requiredText(body.name, '门店名称', 120), body.short == null ? current?.short_name : requiredText(body.short, '门店简称', 80), body.addr == null ? current?.address : requiredText(body.addr, '门店地址', 300), body.latitude == null ? current?.latitude : numberValue(body.latitude, '纬度', -90, 90), body.longitude == null ? current?.longitude : numberValue(body.longitude, '经度', -180, 180), body.phone == null ? current?.phone : requiredText(body.phone, '门店电话', 40), body.hours == null ? current?.business_hours : requiredText(body.hours, '营业时间', 80), body.img == null ? current?.image || '' : text(body.img, 500), status];
    if (current) {
      await execute(this.db, 'UPDATE stores SET name=?,short_name=?,address=?,latitude=?,longitude=?,phone=?,business_hours=?,image=?,status=?,updated_at=? WHERE id=?', ...row, now, id);
    } else {
      await execute(this.db, `INSERT INTO stores (
        id,name,short_name,address,latitude,longitude,phone,business_hours,image,status,created_by_admin_id,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, finalId, ...row, admin.id, now, now);
    }
    await this.audit({
      actorType: 'admin',
      actorId: admin.id,
      actorName: admin.name,
      action: current ? 'update_store' : 'create_store',
      entityType: 'store',
      entityId: finalId,
      ip,
      result: '保存成功'
    });
    const saved = await queryOne(this.db, `SELECT s.*, creator.name AS created_by_name, creator.username AS created_by_username
      FROM stores s LEFT JOIN admin_users creator ON creator.id=s.created_by_admin_id WHERE s.id=?`, finalId);
    return {
      ...storeView(saved),
      createdByAdminId: saved.created_by_admin_id || '',
      createdByName: saved.created_by_name || '',
      createdByUsername: saved.created_by_username || ''
    };
  }
  async deleteStore(admin, id, ip = '') {
    this.assertStoreAdminWrite(admin);
    const current = await this.storeForAdmin(admin, id);
    const stats = await queryOne(this.db, `SELECT
      (SELECT COUNT(*) FROM store_accounts WHERE store_id=?) AS account_count,
      (SELECT COUNT(*) FROM redemptions r WHERE preferred_store_id=? OR verified_store_id=? OR EXISTS (
        SELECT 1 FROM store_accounts sa WHERE sa.id=r.verified_by_account_id AND sa.store_id=?
      )) AS redemption_count`, id, id, id, id);
    const redemptionCount = Number(stats.redemption_count || 0);
    assert(redemptionCount === 0, 409, 'ERR_STORE_HAS_HISTORY', `该门店已有 ${redemptionCount} 条兑奖或核销关联记录，为保护正式历史数据不能删除；请将门店状态改为停用`);
    const accountCount = Number(stats.account_count || 0);
    await transaction(this.db, async () => {
      await execute(this.db, 'DELETE FROM stores WHERE id=?', id);
      await this.audit({
        actorType: 'admin',
        actorId: admin.id,
        actorName: admin.name,
        action: 'delete_store',
        entityType: 'store',
        entityId: id,
        ip,
        result: '删除成功',
        detail: { name: current.name, deletedAccounts: accountCount }
      });
    });
    return { id, name: current.name, deleted: { accounts: accountCount } };
  }
  async storeAccounts(admin, storeId) {
    await this.storeForAdmin(admin, storeId);
    return (await queryAll(this.db, 'SELECT sa.*,s.short_name AS store_name FROM store_accounts sa LEFT JOIN stores s ON s.id=sa.store_id WHERE sa.store_id=? ORDER BY sa.created_at DESC', storeId)).map(accountView);
  }
  async createStoreAccountAdmin(admin, storeId, body, ip = '') {
    this.assertStoreAdminWrite(admin);
    await this.storeForAdmin(admin, storeId);
    const now = Date.now();
    const id = randomId('U');
    const role = body.role === 'owner' ? 'owner' : 'staff';
    try {
      await execute(this.db, 'INSERT INTO store_accounts VALUES (?,?,?,?,?,?,?,?,?,1,NULL,?,?)', id, storeId, requiredText(body.username, '账号', 80), hashPassword(accountPassword(body.password)), requiredText(body.name, '姓名', 80), text(body.phone, 30), text(body.avatar, 500), role, JSON.stringify(role === 'owner' ? ['verify', 'orders', 'stats', 'logs', 'staff'] : ['verify']), now, now);
    } catch (error) {
      uniqueConstraint(error, '登录账号已存在');
    }
    await this.audit({
      actorType: 'admin',
      actorId: admin.id,
      actorName: admin.name,
      action: 'create_store_account',
      entityType: 'store_account',
      entityId: id,
      storeId,
      ip,
      result: '创建成功'
    });
    return accountView(await queryOne(this.db, 'SELECT sa.*,s.short_name AS store_name FROM store_accounts sa LEFT JOIN stores s ON s.id=sa.store_id WHERE sa.id=?', id));
  }
  adminRedemptionFilter(query = {}) {
    const params = [];
    let where = ' WHERE 1=1';
    if (query.status) {
      assert(new Set(['pending', 'verified', 'frozen', 'expired', 'lose']).has(query.status), 400, 'ERR_STATUS', '订单状态不正确');
      where += ' AND r.status=?';
      params.push(query.status);
    }
    if (query.storeId) {
      where += ' AND (r.preferred_store_id=? OR r.verified_store_id=?)';
      params.push(query.storeId, query.storeId);
    }
    if (query.batchId) {
      where += ' AND r.batch_id=?';
      params.push(query.batchId);
    }
    if (query.keyword) {
      where += ' AND (r.code LIKE ? OR r.order_no LIKE ? OR c.nickname LIKE ? OR c.phone LIKE ?)';
      const k = `%${text(query.keyword, 80)}%`;
      params.push(k, k, k, k);
    }
    if (query.start) {
      where += ' AND r.redeemed_at>=?';
      params.push(Number(query.start));
    }
    if (query.end) {
      where += ' AND r.redeemed_at<?';
      params.push(Number(query.end));
    }
    return { where, params };
  }
  async adminRedemptions(query = {}) {
    await this.expireOrders();
    const {
      page,
      pageSize
    } = parsePage(query);
    const { where, params } = this.adminRedemptionFilter(query);
    const total = (await queryOne(this.db, 'SELECT COUNT(*) AS total FROM redemptions r JOIN customers c ON c.id=r.customer_id' + where, ...params)).total;
    const rows = await queryAll(this.db, redemptionJoin + where + ' ORDER BY r.redeemed_at DESC LIMIT ? OFFSET ?', ...params, pageSize, (page - 1) * pageSize);
    return paged(rows.map(redemptionView), total, page, pageSize);
  }
  async adminRedemptionRows(query = {}) {
    await this.expireOrders();
    const { where, params } = this.adminRedemptionFilter(query);
    return (await queryAll(this.db, redemptionJoin + where + ' ORDER BY r.redeemed_at DESC', ...params)).map(redemptionView);
  }
  async freezeRedemption(admin, id, freeze, reason, ip = '') {
    return transaction(this.db, async () => {
    this.assertAdminWrite(admin);
    const row = await queryOne(this.db, 'SELECT * FROM redemptions WHERE id=? FOR UPDATE', id);
    assert(row, 404, 'ERR_RECORD_NOT_FOUND', '订单不存在');
    assert(!await queryOne(this.db, 'SELECT redemption_id FROM cash_rewards WHERE redemption_id=?', id), 409, 'ERR_CASH_IN_FLIGHT', '红包已发起领取，请先核对微信转账结果');

    if (freeze) {
      assert(row.status === 'pending', 409, 'ERR_RECORD_STATE', '仅待核销订单可以冻结');
      const why = requiredText(reason, '冻结原因', 300);
      await execute(this.db, "UPDATE redemptions SET status='frozen',frozen_reason=?,updated_at=? WHERE id=?", why, Date.now(), id);
    } else {
      assert(row.status === 'frozen', 409, 'ERR_RECORD_STATE', '订单当前不是冻结状态');
      assert(row.expires_at > Date.now(), 409, 'ERR_EXPIRED', '订单已过有效期，无法解冻');
      await execute(this.db, "UPDATE redemptions SET status='pending',frozen_reason='',updated_at=? WHERE id=?", Date.now(), id);
    }
    await this.audit({
      actorType: 'admin',
      actorId: admin.id,
      actorName: admin.name,
      action: freeze ? 'freeze_redemption' : 'unfreeze_redemption',
      entityType: 'redemption',
      entityId: id,
      ip,
      result: freeze ? '已冻结' : '已解冻',
      detail: {
        reason: text(reason, 300)
      }
    });
    return redemptionView(await queryOne(this.db, redemptionJoin + ' WHERE r.id=?', id));
    });
  }
  async customers(query = {}) {
    const {
      page,
      pageSize
    } = parsePage(query);
    const params = [];
    let where = ' WHERE 1=1';
    if (query.blocked === '1' || query.blocked === 'true') {
      where += ' AND c.blocked=1';
    }
    if (query.keyword) {
      where += ' AND (c.nickname LIKE ? OR c.phone LIKE ? OR c.openid LIKE ?)';
      const k = `%${text(query.keyword, 80)}%`;
      params.push(k, k, k);
    }
    const total = (await queryOne(this.db, 'SELECT COUNT(*) AS total FROM customers c' + where, ...params)).total;
    const rows = (await queryAll(this.db, `SELECT c.*,COUNT(r.id) AS redemption_count,SUM(CASE WHEN r.won=1 THEN 1 ELSE 0 END) AS win_count FROM customers c LEFT JOIN redemptions r ON r.customer_id=c.id ${where} GROUP BY c.id ORDER BY c.created_at DESC LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize)).map(row => ({
      ...customerView(row),
      redemptionCount: Number(row.redemption_count),
      winCount: Number(row.win_count || 0)
    }));
    return paged(rows, total, page, pageSize);
  }
  async blacklistCustomer(admin, id, blocked, reason, ip = '') {
    this.assertAdminWrite(admin);
    const customer = await queryOne(this.db, 'SELECT * FROM customers WHERE id=?', id);
    assert(customer, 404, 'ERR_CUSTOMER_NOT_FOUND', '用户不存在');
    const isBlocked = boolInt(blocked);
    const why = isBlocked ? requiredText(reason, '限制原因', 300) : '';
    await execute(this.db, 'UPDATE customers SET blocked=?,blocked_reason=?,updated_at=? WHERE id=?', isBlocked, why, Date.now(), id);
    await this.audit({
      actorType: 'admin',
      actorId: admin.id,
      actorName: admin.name,
      action: isBlocked ? 'blacklist_customer' : 'unblacklist_customer',
      entityType: 'customer',
      entityId: id,
      ip,
      result: isBlocked ? '已限制' : '已解除',
      detail: {
        reason: why
      }
    });
    return customerView(await queryOne(this.db, 'SELECT * FROM customers WHERE id=?', id));
  }
  async auditLogs(query = {}) {
    const {
      page,
      pageSize
    } = parsePage(query);
    const params = [];
    let where = ' WHERE 1=1';
    if (query.actorType) {
      where += ' AND actor_type=?';
      params.push(query.actorType);
    }
    if (query.action) {
      where += ' AND action=?';
      params.push(query.action);
    }
    if (query.storeId) {
      where += ' AND store_id=?';
      params.push(query.storeId);
    }
    if (query.keyword) {
      where += ' AND (actor_name LIKE ? OR entity_id LIKE ? OR result LIKE ?)';
      const k = `%${text(query.keyword, 80)}%`;
      params.push(k, k, k);
    }
    const total = (await queryOne(this.db, 'SELECT COUNT(*) AS total FROM audit_logs' + where, ...params)).total;
    const rows = (await queryAll(this.db, 'SELECT * FROM audit_logs' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?', ...params, pageSize, (page - 1) * pageSize)).map(row => this.auditView(row));
    return paged(rows, total, page, pageSize);
  }
  auditView(row) {
    return {
      id: row.id,
      type: row.action === 'verify' ? 'verify' : row.action === 'verify_blocked' ? 'block' : row.action,
      actorType: row.actor_type,
      byId: row.actor_id,
      byName: row.actor_name,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      storeId: row.store_id || '',
      ip: row.ip,
      pos: row.position,
      result: row.result,
      detail: parseJson(row.detail_json, {}),
      at: row.created_at
    };
  }
  async notificationOutbox(query = {}) {
    const {
      page,
      pageSize
    } = parsePage(query);
    const status = query.status ? text(query.status, 20) : '';
    const where = status ? ' WHERE status=?' : '';
    const params = status ? [status] : [];
    const total = (await queryOne(this.db, 'SELECT COUNT(*) AS total FROM notification_outbox' + where, ...params)).total;
    const rows = (await queryAll(this.db, 'SELECT * FROM notification_outbox' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?', ...params, pageSize, (page - 1) * pageSize)).map(row => ({
      ...row,
      payload: parseJson(row.payload_json, {})
    }));
    return paged(rows, total, page, pageSize);
  }
  async saveUpload(admin, body, ip = '') {
    this.assertStoreAdminWrite(admin);
    const name = requiredText(body.name, '文件名', 160);
    const mime = requiredText(body.mime, '文件类型', 80);
    assert(/^image\/(png|jpeg|webp)$/.test(mime), 400, 'ERR_FILE_TYPE', '仅支持 PNG、JPG、WebP 图片');
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    assert(match, 400, 'ERR_FILE_DATA', '图片数据格式不正确');
    const data = Buffer.from(match[2], 'base64');
    assert(data.length > 0 && data.length <= 5 * 1024 * 1024, 400, 'ERR_FILE_SIZE', '图片大小须在 5MB 以内');
    const suffix = match[1] === 'jpeg' ? '.jpg' : '.' + match[1];
    const filename = `${Date.now()}-${randomId('').slice(0, 10)}${suffix}`;
    try {
      mkdirSync(this.config.uploadDir, {
        recursive: true
      });
      writeFileSync(resolve(this.config.uploadDir, filename), data, {
        flag: 'wx'
      });
    } catch (error) {
      // 最常见的是 UPLOAD_DIR 落在了 systemd ProtectSystem=strict 的只读区
      // （比如照 .env.example 写成 ./uploads，就会指向只读的 current/backend/uploads）。
      // 直接抛出去只会变成一句「服务暂时不可用」，线上根本查不出原因。
      if (error?.code === 'EROFS' || error?.code === 'EACCES' || error?.code === 'EPERM') {
        throw apiError(503, 'ERR_UPLOAD_DIR', `上传目录不可写：${this.config.uploadDir}（${error.code}）。请把 UPLOAD_DIR 指向可写的共享目录后重启服务`);
      }
      throw error;
    }
    await this.audit({
      actorType: 'admin',
      actorId: admin.id,
      actorName: admin.name,
      action: 'upload_image',
      entityType: 'asset',
      entityId: filename,
      ip,
      result: '上传成功',
      detail: {
        originalName: name,
        size: data.length
      }
    });
    return {
      url: `/uploads/${filename}`,
      name,
      size: data.length
    };
  }
}
