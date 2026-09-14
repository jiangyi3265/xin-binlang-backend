import { hashPassword, randomId } from './security.js'
import { execute, transaction } from './database.js'

const DAY = 86_400_000

export const DEFAULT_REDEMPTION_FLOW = [
  { no: '01', title: '购买活动产品', description: '购买带有“开码有奖”标识的倌榔产品' },
  { no: '02', title: '获取数字兑换码', description: '打开包装，找到包装内的 6 位数字兑换码' },
  { no: '03', title: '登录后自主选牌', description: '微信登录后输入兑换码，选择一张牌翻开本次结果' },
  { no: '04', title: '按奖励领取', description: '换购奖到店补款核销；现金红包在微信小程序内领取' }
]

export const DEFAULT_PRODUCT_IMAGE = '/assets/guanlang-product-50.jpg'
export const DEFAULT_BRAND_BACKGROUND = '/assets/guanlang-botanical-blue.png'

async function runMany(db, sql, rows) {
  for (const row of rows) await execute(db, sql, ...row)
}

function orderNo(time, seq) {
  const d = new Date(time)
  const p2 = value => String(value).padStart(2, '0')
  return `JL${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${String(seq).padStart(5, '0')}`
}

export async function seedDatabase(db) {
  const seedPasswords = {}
  for (const role of ['ADMIN', 'OPERATOR', 'SALES', 'STORE']) {
    const value = process.env[`SEED_${role}_PASSWORD`] || ''
    if (value.length < 16) throw new Error(`演示数据初始化需要在本地环境配置至少 16 位的 SEED_${role}_PASSWORD`)
    seedPasswords[role] = value
  }
  const now = Date.now()
  const activeStart = now - 45 * DAY
  const activeEnd = now + 180 * DAY
  const expiredStart = now - 240 * DAY
  const expiredEnd = now - 30 * DAY

  return transaction(db, async () => {
    await execute(db, `INSERT INTO settings (
      id, brand, brand_en, activity_name, activity_subtitle, slogan, active,
      activity_start, activity_end, daily_limit, prize_valid_days, home_bg,
      poster, product_image, rule_bg, notice_json, flow_json, service_json, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, 1, ?, ?, 0, 30, ?, ?, ?, ?, ?, ?, ?, ?)`,
        '倌榔', 'GUANLANG', '开码有奖', '一码一兑 · 开袋见喜', '撕开包装，码上开奖',
        new Date(activeStart).toISOString().slice(0, 10), new Date(activeEnd).toISOString().slice(0, 10),
        DEFAULT_BRAND_BACKGROUND, '/assets/hero-fruit.jpg', DEFAULT_PRODUCT_IMAGE, DEFAULT_BRAND_BACKGROUND,
        JSON.stringify({ enabled: true, badge: '公告', buttonText: '我知道了', image: '', title: '第三期活动已上线', date: new Date(now).toISOString().slice(0, 10), lines: ['新增臻享奖池，20 元档兑换码专享大奖。', '中奖后请于 30 天内到门店核销。', '当前活动不限制每日兑奖次数。'] }),
        JSON.stringify(DEFAULT_REDEMPTION_FLOW),
        JSON.stringify({ phone: '400-628-1868', wechat: '', hours: '09:00 - 21:00' }),
        now)

    const customers = [
      ['C001', 'demo-customer', '槟榔老饕', '138****6721', '/assets/avatar-1.jpg', 0, ''],
      ['C002', 'customer-2', '长沙小王', '159****2043', '/assets/avatar-2.jpg', 0, ''],
      ['C003', 'customer-3', '阿杰', '187****9908', '/assets/avatar-3.jpg', 0, ''],
      ['C004', 'customer-4', '米粉不加辣', '133****4417', '/assets/avatar-4.jpg', 0, ''],
      ['C005', 'customer-5', '南城旧梦', '186****7280', '/assets/avatar-5.jpg', 0, ''],
      ['C006', 'blocked-demo', '受限用户', '177****1108', '/assets/avatar-6.jpg', 1, '高频异常兑奖，等待人工复核']
    ].map(row => [...row, now - 90 * DAY, now])
    await runMany(db, 'INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', customers)

    const adminPassword = hashPassword(seedPasswords.ADMIN)
    const operatorPassword = hashPassword(seedPasswords.OPERATOR)
    await runMany(db, 'INSERT INTO admin_users VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)', [
      ['A001', 'admin', adminPassword, '总部管理员', 'super_admin', 1, now, now],
      ['A002', 'operator', operatorPassword, '活动运营', 'operator', 1, now, now],
      ['A003', 'auditor', operatorPassword, '审计专员', 'auditor', 1, now, now],
      ['A004', 'sales_demo', hashPassword(seedPasswords.SALES), '销售示例账号', 'sales', 1, now, now]
    ])

    const stores = [
      ['S01', '倌榔雨花亭旗舰店', '雨花亭旗舰店', '长沙市雨花区韶山中路 168 号 1 楼', 28.1682, 113.0007, '0731-8888-0101', '08:00 - 23:00', '/assets/store-1.jpg'],
      ['S02', '倌榔五一广场店', '五一广场店', '长沙市芙蓉区黄兴中路 88 号 B1-12', 28.1942, 112.9760, '0731-8888-0102', '09:00 - 24:00', '/assets/store-2.jpg'],
      ['S03', '倌榔岳麓大学城店', '岳麓大学城店', '长沙市岳麓区麓山南路 932 号', 28.1685, 112.9444, '0731-8888-0103', '08:30 - 22:30', '/assets/store-3.jpg'],
      ['S04', '倌榔星沙万家丽店', '星沙万家丽店', '长沙县万家丽北路 58 号', 28.2510, 113.0801, '0731-8888-0104', '08:30 - 23:00', '/assets/store-4.jpg'],
      ['S05', '倌榔开福万达店', '开福万达店', '长沙市开福区中山路 589 号', 28.2051, 112.9796, '0731-8888-0105', '09:00 - 22:30', '/assets/store-2.jpg'],
      ['S06', '倌榔天心阁店', '天心阁店', '长沙市天心区城南西路 33 号', 28.1830, 112.9824, '0731-8888-0106', '08:30 - 22:30', '/assets/store-3.jpg']
    ].map((row, index) => [...row, 'active', index < 2 ? 'A004' : null, now, now])
    await runMany(db, `INSERT INTO stores (
      id,name,short_name,address,latitude,longitude,phone,business_hours,image,status,created_by_admin_id,created_at,updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, stores)

    const storePassword = hashPassword(seedPasswords.STORE)
    await runMany(db, 'INSERT INTO store_accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)', [
      ['U01', 'S01', 'yht_owner', storePassword, '张伟', '138****6721', '/assets/avatar-1.jpg', 'owner', JSON.stringify(['verify','orders','stats','logs','staff']), 1, now, now],
      ['U02', 'S01', 'yht_staff1', storePassword, '李芳', '159****2043', '/assets/avatar-2.jpg', 'staff', JSON.stringify(['verify']), 1, now, now],
      ['U03', 'S01', 'yht_staff2', storePassword, '陈磊', '187****9908', '/assets/avatar-3.jpg', 'staff', JSON.stringify(['verify']), 1, now, now],
      ['U04', 'S02', 'wy_owner', storePassword, '周敏', '186****7280', '/assets/avatar-4.jpg', 'owner', JSON.stringify(['verify','orders','stats','logs','staff']), 1, now, now],
      ['U05', 'S03', 'yl_owner', storePassword, '刘洋', '135****9940', '/assets/avatar-5.jpg', 'owner', JSON.stringify(['verify','orders','stats','logs','staff']), 1, now, now],
      ['U99', null, 'hq_super', storePassword, '总部核销专员', '400****868', '/assets/avatar-7.jpg', 'hq', JSON.stringify(['verify','orders','stats','logs']), 1, now, now]
    ])

    const pools = [
      ['P-A', '臻享奖池', '20 元档专属高价值奖池', '20 元档'],
      ['P-B', '优选奖池', '10 元档品质奖品池', '10 元档'],
      ['P-C', '乐享奖池', '5 元档高频惠赠奖池', '5 元档']
    ].map(row => [...row, 'active', now, now])
    await runMany(db, 'INSERT INTO prize_pools VALUES (?, ?, ?, ?, ?, ?, ?)', pools)

    const prizes = [
      ['PZ01','P-A','智能运动手表','曜石黑','一等奖','goods',39900,38,12,8,1,'/assets/prize-watch.jpg'],
      ['PZ02','P-A','头戴式蓝牙耳机','哑光黑 / 主动降噪','二等奖','goods',29900,62,18,10,1.2,'/assets/prize-headphone.jpg'],
      ['PZ03','P-A','便携蓝牙音箱','森林绿','三等奖','goods',25900,24,20,10,1.4,'/assets/prize-speaker.jpg'],
      ['PZ04','P-A','商务双肩包','深灰色','四等奖','goods',19900,88,28,15,1.7,'/assets/prize-backpack.jpg'],
      ['PZ05','P-A','现金红包 ¥50','微信红包','五等奖','cash',5000,160,40,20,2.2,'/assets/prize-cash.jpg'],
      ['PZ06','P-A','真空保温杯','500ml','六等奖','goods',8900,0,66,10,2.6,'/assets/prize-bottle.jpg'],
      ['PZ07','P-B','智能运动手环','曜石黑','一等奖','goods',14900,72,26,12,1,'/assets/prize-band.jpg'],
      ['PZ08','P-B','真空保温杯','500ml','二等奖','goods',8900,136,44,20,1.5,'/assets/prize-bottle.jpg'],
      ['PZ09','P-B','现金红包 ¥20','微信红包','三等奖','cash',2000,280,110,40,2.2,'/assets/prize-cash.jpg'],
      ['PZ10','P-B','零食大礼包','精选组合装','四等奖','goods',5900,195,68,30,2.8,'/assets/prize-snack.jpg'],
      ['PZ11','P-B','陶瓷马克杯','350ml','五等奖','goods',3900,240,85,40,3.2,'/assets/prize-mug.jpg'],
      ['PZ12','P-C','饮用水一提','12 瓶装','一等奖','goods',3000,420,155,50,1.6,'/assets/prize-water.jpg'],
      ['PZ13','P-C','现金红包 ¥5','微信红包','二等奖','cash',500,760,290,80,2.5,'/assets/prize-cash.jpg'],
      ['PZ14','P-C','平台优惠券','满 20 减 3 元','参与奖','coupon',300,9999,650,200,4,'/assets/prize-mug.jpg']
    ].map(row => [...row, 'active', now, now])
    await runMany(db, 'INSERT INTO prizes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', prizes)

    const batches = [
      ['JL2601','臻享 20 元档第三期','20 元档',2000,'P-A',120000,'active',activeStart,activeEnd],
      ['JL2602','优选 10 元档第三期','10 元档',1000,'P-B',180000,'active',activeStart,activeEnd],
      ['JL2603','乐享 5 元档第三期','5 元档',500,'P-C',250000,'active',activeStart,activeEnd],
      ['JL2504','历史批次','10 元档',1000,'P-B',180000,'expired',expiredStart,expiredEnd]
    ].map(row => [...row, now, now])
    await runMany(db, 'INSERT INTO batches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', batches)

    const demoCodes = [
      ['JL8K2M','JL2601','unused','win','PZ02'],
      ['F6R3V9','JL2602','unused','win','PZ08'],
      ['A7X9Q2','JL2602','unused','lose',null],
      ['E1P8W3','JL2603','unused','lose',null],
      ['B3K7T1','JL2602','redeemed',null,null],
      ['C9M4Z8','JL2504','unused',null,null],
      ['H4W6L5','JL2601','unused','win','PZ06'],
      ['D5N2Y6','JL2602','redeemed','win','PZ09'],
      ['T9B4X1','JL2602','redeemed','win','PZ11'],
      ['Q2W5E8','JL2601','redeemed','win','PZ03'],
      ['Z5X8C2','JL2602','redeemed','win','PZ08'],
      ['V7B2N6','JL2603','redeemed','win','PZ13'],
      ['H3G7F2','JL2602','verified','win','PZ07'],
      ['P8O2I6','JL2603','verified','win','PZ12'],
      ['X7C3V9','JL2602','redeemed','win','PZ09']
    ]
    let codeSeq = 0
    const used = new Set(demoCodes.map(row => row[0]))
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    while (demoCodes.length < 135) {
      const num = codeSeq++
      let value = num + 987654
      let code = ''
      for (let i = 0; i < 6; i++) {
        code += alphabet[value % alphabet.length]
        value = Math.floor(value / alphabet.length) + i * 19
      }
      if (used.has(code)) continue
      used.add(code)
      demoCodes.push([code, ['JL2601','JL2602','JL2603'][num % 3], 'unused', null, null])
    }
    await runMany(db, 'INSERT INTO redeem_codes VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)', demoCodes.map(row => [...row, now - 10 * DAY]))

    let seq = 4200
    const redemptionRows = []
    const records = [
      { code:'D5N2Y6', batch:'JL2602', pool:'P-B', customer:'C001', prize:'PZ09', status:'pending', store:'S01', redeemed:now-3*DAY, expires:now+27*DAY },
      { code:'T9B4X1', batch:'JL2602', pool:'P-B', customer:'C001', prize:'PZ11', status:'pending', store:'S02', redeemed:now-28*DAY, expires:now+2*DAY },
      { code:'Q2W5E8', batch:'JL2601', pool:'P-A', customer:'C002', prize:'PZ03', status:'pending', store:'S01', redeemed:now-2*60*60*1000, expires:now+30*DAY },
      { code:'Z5X8C2', batch:'JL2602', pool:'P-B', customer:'C003', prize:'PZ08', status:'pending', store:'S01', redeemed:now-5*60*60*1000, expires:now+30*DAY },
      { code:'V7B2N6', batch:'JL2603', pool:'P-C', customer:'C004', prize:'PZ13', status:'pending', store:'S01', redeemed:now-9*60*60*1000, expires:now+29*DAY },
      { code:'H3G7F2', batch:'JL2602', pool:'P-B', customer:'C002', prize:'PZ07', status:'verified', store:'S01', verifiedStore:'S01', by:'U01', redeemed:now-2*DAY, expires:now+28*DAY, verified:now-20*60*60*1000 },
      { code:'P8O2I6', batch:'JL2603', pool:'P-C', customer:'C003', prize:'PZ12', status:'verified', store:'S01', verifiedStore:'S01', by:'U02', redeemed:now-3*DAY, expires:now+27*DAY, verified:now-30*60*60*1000 },
      { code:'X7C3V9', batch:'JL2602', pool:'P-B', customer:'C005', prize:'PZ09', status:'frozen', store:'S01', redeemed:now-8*DAY, expires:now+22*DAY, frozen:'同一设备短时间高频兑奖，等待总部复核' }
    ]
    const prizeMap = new Map(prizes.map(row => [row[0], row]))
    for (const record of records) {
      const id = `R${String(++seq).padStart(8, '0')}`
      const prize = prizeMap.get(record.prize)
      const snapshot = { id: prize[0], name: prize[2], specification: prize[3], level: prize[4], category: prize[5], valueCents: prize[6], image: prize[11] }
      redemptionRows.push([
        id, orderNo(record.redeemed, seq), record.code, record.batch, record.pool, record.customer, record.prize,
        1, record.status, JSON.stringify(snapshot), record.store, record.verifiedStore || null, record.by || null,
        record.verified ? '长沙市雨花区韶山中路 168 号（门店定位）' : '', record.frozen || '',
        record.redeemed, record.expires, record.verified || null, now
      ])
      await execute(db, 'UPDATE redeem_codes SET status = ?, redeemed_at = ?, redemption_id = ? WHERE code = ?', record.status === 'verified' ? 'verified' : 'redeemed', record.redeemed, id, record.code)
    }
    await runMany(db, 'INSERT INTO redemptions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', redemptionRows)

    const notices = [
      ['N001','C001','expiring','中奖奖品即将到期','您的「陶瓷马克杯」还有 2 天到期，请尽快到店核销。','T9B4X1',0,now-2*60*60*1000],
      ['N002','C001','win','恭喜中奖','您通过兑换码 D5N2Y6 抽中「现金红包 ¥20」，30 天内到店核销有效。','D5N2Y6',0,now-3*DAY],
      ['N003','C001','coupon','优惠券已到账','未中奖补偿券已发放，请在有效期内使用。','',1,now-5*DAY],
      ['N004','C002','verify','核销完成','您的奖品已在雨花亭旗舰店完成核销。','H3G7F2',1,now-20*60*60*1000]
    ]
    await runMany(db, 'INSERT INTO notices VALUES (?, ?, ?, ?, ?, ?, ?, ?)', notices)

    await runMany(db, 'INSERT INTO coupons VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      ['CP001','C001',null,'满 30 减 5 元','新人礼',500,3000,'valid','新人礼',now-30*DAY,now+6*DAY,null],
      ['CP002','C001',null,'满 20 减 3 元','未中奖补偿券',300,2000,'valid','兑换码历史活动',now-5*DAY,now+25*DAY,null]
    ])

    for (const record of records.filter(item => item.status === 'verified')) {
      const redemption = redemptionRows.find(row => row[2] === record.code)
      await execute(db, 'INSERT INTO audit_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        randomId('LG'), 'store', record.by, record.by === 'U01' ? '张伟' : '李芳', 'verify', 'redemption', redemption[0],
        record.verifiedStore, '127.0.0.1', redemption[13], '核销成功', JSON.stringify({ code: record.code }), record.verified
      )
    }

    await execute(db, "INSERT INTO schema_meta(`key`, value) VALUES ('seed_version', '1')")
  })
}
