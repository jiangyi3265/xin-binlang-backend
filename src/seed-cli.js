import { loadConfig } from './config.js'
import { openDatabase } from './database.js'

const config = loadConfig()
const db = await openDatabase(config)
await db.close()
console.log(`MySQL 数据库已初始化：${config.database.host}:${config.database.port}/${config.database.name}`)
